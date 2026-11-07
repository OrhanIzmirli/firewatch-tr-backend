import pool from '../config/database';
import { recordJobRun } from '../services/jobRunRecorder';
import { heatSourceSqlCondition } from '../services/heatSource';
import notificationService, { forgetDeadTokens, PushMessage } from '../services/notificationService';
import {
  HEAT_ALERT_CAP_WINDOW_HOURS,
  HEAT_ALERT_DEVICE_CAP,
  HEAT_ALERT_MAX_AGE_HOURS,
  HEAT_ALERT_MIN_TIERS,
  HEAT_ALERT_TTL_SECONDS,
  Locale,
  PLACES_ANDROID_CHANNEL,
  buildHeatAlertText,
  trackedPlacesAvailable,
} from '../services/trackedPlaces';

/**
 * Tracked-place heat alerts (app 1.2.0). Runs right after clustering, in the
 * same ingest tick (jobs/fireIngestJob.ts).
 *
 * 1. Every (place, incident) pair where the incident centroid is inside the
 *    place's radius, the incident was seen in the last 12 h, has reached
 *    nominal or high confidence, and is not a persistent heat source, is
 *    recorded in place_notifications. The primary key makes that a one-time
 *    event per pair: whatever happens later, the pair never alerts again.
 * 2. New pairs are grouped per device: one push names the nearest pair and
 *    counts the rest ("+N more").
 * 3. A device gets at most HEAT_ALERT_DEVICE_CAP pushes per
 *    HEAT_ALERT_CAP_WINDOW_HOURS; pairs over the cap are recorded as not
 *    delivered and never sent later.
 *
 * An incident that starts as a low-confidence pixel is not recorded until it
 * reaches nominal/high, so it alerts at that moment, once.
 */
export interface PlaceAlertStats {
  skipped: boolean;
  newPairs: number;
  devicesNotified: number;
  devicesCapped: number;
  delivered: number;
  failed: number;
  deadTokens: number;
}

interface NewPair {
  place_id: string;
  install_id: string;
  incident_id: string;
  place_name: string;
  distance_m: number;
  /** Incident centroid (satellite data, not the user's), for the map deep link. */
  incident_lat: number;
  incident_lng: number;
  fcm_token: string | null;
  locale: Locale;
  recent_delivered: number;
}

/**
 * The candidate query. Kept as an exported builder so the test can check its
 * shape without a database.
 */
export function newHeatPairsSql(): string {
  const tiers = HEAT_ALERT_MIN_TIERS.map((t) => `'${t}'`).join(', ');
  return `
    WITH candidates AS (
      SELECT p.id AS place_id, p.install_id, i.id AS incident_id
      FROM tracked_places p
      JOIN place_devices d ON d.install_id = p.install_id
      JOIN fire_incidents i
        ON ST_DWithin(p.geom, i.centroid::geography, p.radius_m)
      WHERE p.notify_heat
        AND i.last_detected_at > NOW() - make_interval(hours => ${HEAT_ALERT_MAX_AGE_HOURS})
        AND i.peak_confidence_tier IN (${tiers})
        AND NOT COALESCE((${heatSourceSqlCondition('i')}), false)
    ),
    inserted AS (
      INSERT INTO place_notifications (place_id, kind, ref_key, install_id, delivered)
      SELECT place_id, 'heat', incident_id::text, install_id, false FROM candidates
      ON CONFLICT (place_id, kind, ref_key) DO NOTHING
      RETURNING place_id, ref_key, install_id
    )
    SELECT ins.place_id, ins.install_id, ins.ref_key AS incident_id,
           p.name AS place_name,
           ST_Distance(p.geom, i.centroid::geography) AS distance_m,
           round(ST_Y(i.centroid)::numeric, 4)::float AS incident_lat,
           round(ST_X(i.centroid)::numeric, 4)::float AS incident_lng,
           d.fcm_token, d.locale,
           (SELECT count(*)::int FROM place_notifications n
             WHERE n.install_id = ins.install_id AND n.delivered
               AND n.created_at > NOW() - make_interval(hours => ${HEAT_ALERT_CAP_WINDOW_HOURS})) AS recent_delivered
    FROM inserted ins
    JOIN tracked_places p ON p.id = ins.place_id
    JOIN place_devices d ON d.install_id = ins.install_id
    JOIN fire_incidents i ON i.id = ins.ref_key::bigint
  `;
}

export interface DevicePush {
  installId: string;
  token: string;
  locale: Locale;
  nearest: NewPair;
  extra: number;
}

/**
 * Pure: turns the new pairs into at most one push per device, honouring the
 * cap. Devices without a live token, or at the cap, get nothing.
 */
export function planDevicePushes(pairs: NewPair[]): { pushes: DevicePush[]; capped: number } {
  const byDevice = new Map<string, NewPair[]>();
  for (const pair of pairs) {
    const list = byDevice.get(pair.install_id) ?? [];
    list.push(pair);
    byDevice.set(pair.install_id, list);
  }
  const pushes: DevicePush[] = [];
  let capped = 0;
  for (const [installId, list] of byDevice) {
    const first = list[0];
    if (!first.fcm_token) continue;
    if (first.recent_delivered >= HEAT_ALERT_DEVICE_CAP) {
      capped++;
      continue;
    }
    const sorted = [...list].sort((a, b) => Number(a.distance_m) - Number(b.distance_m));
    // Distinct incidents beyond the one named: two places seeing the same
    // fire are still one fire.
    const incidents = new Set(list.map((p) => p.incident_id));
    pushes.push({
      installId,
      token: first.fcm_token,
      locale: first.locale === 'en' ? 'en' : 'tr',
      nearest: sorted[0],
      extra: incidents.size - 1,
    });
  }
  return { pushes, capped };
}

export function buildPushMessage(push: DevicePush): PushMessage {
  const text = buildHeatAlertText(push.locale, push.nearest.place_name, Number(push.nearest.distance_m), push.extra);
  return {
    token: push.token,
    title: text.title,
    body: text.body,
    data: {
      type: 'place_heat',
      place_id: push.nearest.place_id,
      incident_id: String(push.nearest.incident_id),
      lat: String(push.nearest.incident_lat),
      lng: String(push.nearest.incident_lng),
    },
    androidChannelId: PLACES_ANDROID_CHANNEL,
    // Same incident → same tag, so a resend can never stack two banners.
    tag: `incident-${push.nearest.incident_id}`,
    ttlSeconds: HEAT_ALERT_TTL_SECONDS,
  };
}

class PlaceAlertJob {
  async run(): Promise<PlaceAlertStats> {
    const startedAt = new Date();
    const stats: PlaceAlertStats = {
      skipped: false, newPairs: 0, devicesNotified: 0, devicesCapped: 0, delivered: 0, failed: 0, deadTokens: 0,
    };
    if (!(await trackedPlacesAvailable(pool))) {
      stats.skipped = true;
      return stats; // migration 014 not applied: nothing to do, nothing to record
    }
    try {
      const result = await pool.query(newHeatPairsSql());
      const pairs = result.rows as NewPair[];
      stats.newPairs = pairs.length;
      if (pairs.length === 0) {
        await recordJobRun('place_alerts', startedAt, 'ok', { ...stats });
        return stats;
      }

      const { pushes, capped } = planDevicePushes(pairs);
      stats.devicesCapped = capped;
      const results = await notificationService.sendMessages(pushes.map(buildPushMessage));

      const deliveredDevices: string[] = [];
      const deadTokens: string[] = [];
      results.forEach((r, i) => {
        if (r.success) deliveredDevices.push(pushes[i].installId);
        else if (r.deadToken) deadTokens.push(pushes[i].token);
      });
      stats.devicesNotified = deliveredDevices.length;
      stats.failed = results.length - deliveredDevices.length;

      if (deliveredDevices.length > 0) {
        // Every new pair of a notified device counts as delivered (they
        // were all folded into its one push).
        const marked = await pool.query(
          `UPDATE place_notifications SET delivered = true
           WHERE kind = 'heat' AND install_id = ANY($1::uuid[])
             AND (place_id, ref_key) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))`,
          [
            deliveredDevices,
            pairs.map((p) => p.place_id),
            pairs.map((p) => String(p.incident_id)),
          ]
        );
        stats.delivered = marked.rowCount ?? 0;
      }
      if (deadTokens.length > 0) {
        stats.deadTokens = deadTokens.length;
        await pool.query(
          `UPDATE place_devices SET fcm_token = NULL, token_invalid_at = NOW()
           WHERE fcm_token = ANY($1::text[])`,
          [deadTokens]
        );
        // The same token may also be on fcm_tokens; it is just as dead there.
        await forgetDeadTokens(deadTokens);
      }

      console.log(
        `📍 Place alerts: ${stats.newPairs} new place/incident pair(s), ${stats.devicesNotified} device(s) notified, ` +
          `${stats.devicesCapped} at the cap, ${stats.failed} failed, ${stats.deadTokens} dead token(s)`
      );
      await recordJobRun('place_alerts', startedAt, 'ok', { ...stats });
      return stats;
    } catch (error) {
      console.error('Place alerts failed:', (error as Error).message);
      await recordJobRun('place_alerts', startedAt, 'failed', { ...stats }, error);
      return stats;
    }
  }
}

export default new PlaceAlertJob();
