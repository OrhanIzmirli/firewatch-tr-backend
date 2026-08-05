import { Request, Response } from 'express';
import pool from '../config/database';
import notificationService from '../services/notificationService';
import { isRegionKey, regionKeyForCoordinates, regionKeyForRegionName } from '../utils/regions';
import { resolveLocation } from '../services/locationService';

type AlertScope = 'all' | 'region' | 'city';

interface ScopePreferences {
  alertScope: AlertScope | null;
  regionKey: string | null;
  cityId: number | null;
}

/**
 * Reads the optional scope fields off a request body.
 *
 * All three are optional so old clients — which know nothing about scopes —
 * keep working untouched: when `alert_scope` is absent the caller leaves the
 * stored preference exactly as it was.
 *
 * Returns a string when the payload is invalid, so the caller can 400.
 */
function parseScopePreferences(body: any): ScopePreferences | string {
  const rawScope = body?.alert_scope;
  if (rawScope === undefined || rawScope === null) {
    return { alertScope: null, regionKey: null, cityId: null };
  }
  if (rawScope !== 'all' && rawScope !== 'region' && rawScope !== 'city') {
    return "alert_scope must be one of 'all', 'region', 'city'";
  }

  if (rawScope === 'region') {
    // region_key is OPTIONAL: when the user picked a region explicitly we
    // honour that pick, and when they only tapped "my region" we derive it
    // server-side from their coordinates. What we never do is accept a
    // region the client computed for itself.
    if (body?.region_key === undefined || body?.region_key === null) {
      return { alertScope: 'region', regionKey: null, cityId: null };
    }
    if (!isRegionKey(body.region_key)) {
      return 'region_key must be a known region when alert_scope is "region"';
    }
    return { alertScope: 'region', regionKey: body.region_key, cityId: null };
  }

  if (rawScope === 'city') {
    const cityId = Number(body?.city_id);
    if (!Number.isInteger(cityId) || cityId <= 0) {
      return 'city_id is required and must be a positive integer when alert_scope is "city"';
    }
    return { alertScope: 'city', regionKey: null, cityId };
  }

  return { alertScope: 'all', regionKey: null, cityId: null };
}

/**
 * Guards the city_id we are about to store. The column has no FK (see
 * migration 001 for why), so this is where referential integrity lives.
 */
async function cityExists(cityId: number): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM turkey_cities WHERE id = $1', [cityId]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Where a device's own region comes from.
 *
 * The client no longer derives this: it asks the server (see
 * /api/fires/nearest-city, which now returns region_key). Anything the client
 * does send is either that server-derived value or a deliberate pick from the
 * region dropdown — never a locally-computed guess.
 *
 * When the caller supplies coordinates and did NOT explicitly choose a region,
 * the region is resolved here from turkey_cities so it can never disagree with
 * the region the risk job alerts on.
 */
async function resolveDeviceRegion(
  explicitRegionKey: string | null,
  lat: number | null,
  lng: number | null
): Promise<string | null> {
  if (explicitRegionKey !== null) return explicitRegionKey;
  if (lat === null || lng === null) return null;
  const resolved = await resolveLocation(lat, lng);
  return resolved.regionKey;
}

class NotificationController {
  async subscribeToken(req: Request, res: Response): Promise<void> {
    try {
      const { token, device_info, latitude, longitude } = req.body;

      if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
        res.status(400).json({ status: 'error', message: 'Token is required' });
        return;
      }

      const lat = latitude === undefined || latitude === null ? null : Number(latitude);
      const lng = longitude === undefined || longitude === null ? null : Number(longitude);
      if ((lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
          (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
        res.status(400).json({ status: 'error', message: 'Invalid coordinates' });
        return;
      }

      // COALESCE keeps whatever location is already on file when this call
      // doesn't supply one (e.g. the app-startup re-subscribe ping), but
      // still overwrites it with a fresh fix when one is supplied (e.g. the
      // "Start Auto Monitoring" flow) — previously the ON CONFLICT branch
      // only touched updated_at/is_active, so a re-subscribe with a new GPS
      // fix silently never reached latitude/longitude at all.
      const scope = parseScopePreferences(req.body);
      if (typeof scope === 'string') {
        res.status(400).json({ status: 'error', message: scope });
        return;
      }
      if (scope.cityId !== null && !(await cityExists(scope.cityId))) {
        res.status(400).json({ status: 'error', message: 'Unknown city_id' });
        return;
      }

      const resolved = lat !== null && lng !== null ? await resolveLocation(lat, lng) : null;
      let regionToStore: string | null = null;
      if (scope.alertScope === 'region') {
        regionToStore = await resolveDeviceRegion(scope.regionKey, lat, lng);
        if (regionToStore === null) {
          res.status(400).json({
            status: 'error',
            message: 'region_key is required when alert_scope is "region" and no location is on file',
          });
          return;
        }
      }

      // The scope COALESCEs mirror the location ones: a client that doesn't
      // send scope fields (an older app version, or the startup re-subscribe
      // ping) leaves the stored preference alone instead of resetting it to
      // 'all' and silently widening what the user asked for.
      await pool.query(
        `INSERT INTO fcm_tokens (token, device_name, device_type, latitude, longitude, is_active, created_at, updated_at,
                                 alert_scope, region_key, city_id)
         VALUES ($1, $2, $3, $4, $5, true, NOW(), NOW(), COALESCE($6, 'all'), $7, $8)
         ON CONFLICT (token) DO UPDATE SET
           updated_at = NOW(),
           is_active = true,
           latitude = COALESCE(EXCLUDED.latitude, fcm_tokens.latitude),
           longitude = COALESCE(EXCLUDED.longitude, fcm_tokens.longitude),
           alert_scope = COALESCE($6, fcm_tokens.alert_scope),
           region_key = CASE WHEN $6 IS NULL THEN fcm_tokens.region_key ELSE $7 END,
           city_id    = CASE WHEN $6 IS NULL THEN fcm_tokens.city_id    ELSE $8 END`,
        [
          token,
          typeof device_info === 'string' ? device_info.slice(0, 100) : 'FireWatch TR',
          'android',
          lat,
          lng,
          scope.alertScope,
          regionToStore,
          scope.cityId,
        ]
      );

      res.status(201).json({
        status: 'success',
        message: 'Device subscribed successfully',
        timestamp: new Date().toISOString(),
        data: {
          alert_scope: scope.alertScope,
          region_key: regionToStore,
          city_id: scope.cityId,
          resolved_city_id: resolved?.cityId ?? null,
          resolved_city_name: resolved?.cityName ?? null,
          resolved_region_key: resolved?.regionKey ?? null,
          resolved_region_name: resolved?.regionName ?? null,
        },
      });
    } catch (error) {
      console.error('Error in subscribeToken:', error);
      res.status(500).json({ status: 'error', message: 'Unable to subscribe device' });
    }
  }

  // Only touches columns confirmed present in every known schema revision
  // (token, is_active) — subscribeToken above references device_name/
  // device_type/updated_at, which aren't in schema.sql, implying the live
  // table was altered out-of-band; avoiding those keeps this safe regardless.
  async unsubscribeToken(req: Request, res: Response): Promise<void> {
    try {
      const { token } = req.body;

      if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
        res.status(400).json({ status: 'error', message: 'Token is required' });
        return;
      }

      await pool.query(`UPDATE fcm_tokens SET is_active = false WHERE token = $1`, [token]);

      res.json({
        status: 'success',
        message: 'Device unsubscribed successfully',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Error in unsubscribeToken:', error);
      res.status(500).json({ status: 'error', message: 'Unable to unsubscribe device' });
    }
  }

  // On/off toggle for an already-registered token. latitude/longitude are
  // optional — when supplied (e.g. a fresh fix from "Start Auto
  // Monitoring"), they're written too so region-targeted alerts have
  // somewhere to match against; when omitted, location is left untouched.
  async setActiveStatus(req: Request, res: Response): Promise<void> {
    try {
      const { token, is_active, latitude, longitude } = req.body;

      if (typeof token !== 'string' || token.length < 20 || token.length > 4096) {
        res.status(400).json({ status: 'error', message: 'Token is required' });
        return;
      }
      if (typeof is_active !== 'boolean') {
        res.status(400).json({ status: 'error', message: 'is_active must be a boolean' });
        return;
      }

      const lat = latitude === undefined || latitude === null ? null : Number(latitude);
      const lng = longitude === undefined || longitude === null ? null : Number(longitude);
      if ((lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
          (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180))) {
        res.status(400).json({ status: 'error', message: 'Invalid coordinates' });
        return;
      }

      const scope = parseScopePreferences(req.body);
      if (typeof scope === 'string') {
        res.status(400).json({ status: 'error', message: scope });
        return;
      }
      if (scope.cityId !== null && !(await cityExists(scope.cityId))) {
        res.status(400).json({ status: 'error', message: 'Unknown city_id' });
        return;
      }

      // Same server-side resolution as subscribe: when the caller asked for
      // 'region' without naming one, derive it from turkey_cities rather than
      // trusting anything the client worked out locally.
      let effectiveLat = lat;
      let effectiveLng = lng;
      if (scope.alertScope === 'region' && scope.regionKey === null &&
          (effectiveLat === null || effectiveLng === null)) {
        // No fresh fix in this request — fall back to the location already on
        // file for this token.
        const stored = await pool.query(
          'SELECT latitude, longitude FROM fcm_tokens WHERE token = $1',
          [token]
        );
        const row = stored.rows[0];
        if (row?.latitude !== null && row?.latitude !== undefined) {
          effectiveLat = Number(row.latitude);
          effectiveLng = Number(row.longitude);
        }
      }

      let regionToStore: string | null = null;
      if (scope.alertScope === 'region') {
        regionToStore = await resolveDeviceRegion(scope.regionKey, effectiveLat, effectiveLng);
        if (regionToStore === null) {
          res.status(400).json({
            status: 'error',
            message: 'region_key is required when alert_scope is "region" and no location is on file',
          });
          return;
        }
      }

      const resolved =
        effectiveLat !== null && effectiveLng !== null
          ? await resolveLocation(effectiveLat, effectiveLng)
          : null;

      const result = await pool.query(
        `UPDATE fcm_tokens SET
           is_active = $2,
           latitude = COALESCE($3, latitude),
           longitude = COALESCE($4, longitude),
           alert_scope = COALESCE($5, alert_scope),
           region_key = CASE WHEN $5 IS NULL THEN region_key ELSE $6 END,
           city_id    = CASE WHEN $5 IS NULL THEN city_id    ELSE $7 END
         WHERE token = $1 RETURNING token, alert_scope, region_key, city_id`,
        [token, is_active, lat, lng, scope.alertScope, regionToStore, scope.cityId]
      );
      if (result.rowCount === 0) {
        res.status(404).json({ status: 'error', message: 'Token not registered' });
        return;
      }

      const row = result.rows[0];
      res.json({
        status: 'success',
        message: 'Notification status updated',
        data: {
          alert_scope: row.alert_scope,
          region_key: row.region_key,
          city_id: row.city_id,
          resolved_city_id: resolved?.cityId ?? null,
          resolved_city_name: resolved?.cityName ?? null,
          resolved_region_key: resolved?.regionKey ?? null,
          resolved_region_name: resolved?.regionName ?? null,
        },
      });
    } catch (error) {
      console.error('Error in setActiveStatus:', error);
      res.status(500).json({ status: 'error', message: 'Unable to update notification status' });
    }
  }

  /**
   * Sends a notification, honouring each device's chosen scope.
   *
   * With latitude/longitude (a fire alert): the event's region key and nearest
   * city are derived, then only devices whose scope matches are targeted —
   * 'all' devices always, 'region' devices when the region matches, 'city'
   * devices when the city matches.
   *
   * Without coordinates: falls back to a broadcast to every active device,
   * which is the pre-existing behaviour and is what an app-wide admin
   * announcement should do. Scope filters *fire* alerts, it is not a mute.
   */
  async sendByLocation(req: Request, res: Response): Promise<void> {
    try {
      const { title, body, latitude, longitude } = req.body;

      if (!title || !body) {
        res.status(400).json({ status: 'error', message: 'title, body required' });
        return;
      }

      const lat = latitude === undefined || latitude === null ? null : Number(latitude);
      const lng = longitude === undefined || longitude === null ? null : Number(longitude);
      const hasCoordinates =
        lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng);

      let tokens: string[];
      let targeting: Record<string, unknown>;

      if (hasCoordinates) {
        const target = await resolveLocation(lat, lng);
        // No LIMIT: sendToTokens chunks into 500s internally, so every matching
        // device is reached instead of an arbitrary first 500.
        const result = await pool.query(
          `SELECT token FROM fcm_tokens
           WHERE is_active = true
             AND (
               alert_scope = 'all'
               OR (alert_scope = 'region' AND region_key IS NOT NULL AND region_key = $1)
               OR (alert_scope = 'city'   AND city_id    IS NOT NULL AND city_id    = $2)
             )`,
          [target.regionKey, target.cityId]
        );
        tokens = result.rows.map((r: any) => r.token);
        targeting = {
          mode: 'scoped',
          region_key: target.regionKey,
          city_id: target.cityId,
          city_name: target.cityName,
          region_name: target.regionName,
        };
      } else {
        const result = await pool.query(
          'SELECT token FROM fcm_tokens WHERE is_active = true'
        );
        tokens = result.rows.map((r: any) => r.token);
        targeting = { mode: 'broadcast' };
      }

      if (tokens.length === 0) {
        res.json({ status: 'success', message: 'No matching devices', sent: 0, targeting });
        return;
      }

      const sent = await notificationService.sendToTokens(tokens, title, body);
      res.json({
        status: 'success',
        message: `Sent to ${sent}/${tokens.length} devices`,
        sent,
        targeted: tokens.length,
        targeting,
      });
    } catch (error) {
      console.error('Error in sendByLocation:', error);
      res.status(500).json({ status: 'error', message: 'Unable to send notification' });
    }
  }

  /** GET /api/notify/cities — the province list backing the scope picker. */
  async listCities(_req: Request, res: Response): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT id, name, region,
                ST_Y(location::geometry) AS lat,
                ST_X(location::geometry) AS lng
         FROM turkey_cities
         ORDER BY name`
      );

      // region_key comes from the province's own region column, folded to the
      // canonical key. The coordinate boxes are only a fallback: they place
      // Konya/Karaman/Nigde/Aksaray in 'akdeniz' and Burdur in 'ege', which
      // would put a device in a different region than the one alerted on.
      const data = result.rows.map((row: any) => ({
        id: row.id,
        name: row.name,
        region: row.region,
        region_key:
          regionKeyForRegionName(row.region) ??
          (row.lat !== null && row.lng !== null
            ? regionKeyForCoordinates(Number(row.lat), Number(row.lng))
            : null),
      }));

      res.set('Cache-Control', 'public, max-age=86400');
      res.json({ status: 'success', data });
    } catch (error) {
      console.error('Error in listCities:', error);
      res.status(500).json({ status: 'error', message: 'Unable to load cities' });
    }
  }

  async sendToToken(req: Request, res: Response): Promise<void> {
    try {
      const { token, title, body, data } = req.body;

      if (!token || !title || !body) {
        res.status(400).json({ status: 'error', message: 'token, title, body required' });
        return;
      }

      const success = await notificationService.sendToToken(token, title, body, data);
      res.json({ status: success ? 'success' : 'error', message: success ? 'Sent' : 'Failed' });
    } catch (error) {
      res.status(500).json({ status: 'error', message: 'Unable to send notification' });
    }
  }

  async sendToTopic(req: Request, res: Response): Promise<void> {
    try {
      const { topic, title, body, data } = req.body;

      if (!topic || !title || !body) {
        res.status(400).json({ status: 'error', message: 'topic, title, body required' });
        return;
      }

      const success = await notificationService.sendToTopic(topic, title, body, data);
      res.json({ status: success ? 'success' : 'error', message: success ? 'Sent' : 'Failed' });
    } catch (error) {
      res.status(500).json({ status: 'error', message: 'Unable to send notification' });
    }
  }
}

export default new NotificationController();
