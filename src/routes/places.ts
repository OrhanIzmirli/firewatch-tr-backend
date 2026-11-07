import { NextFunction, Request, Response, Router } from 'express';
import pool from '../config/database';
import { consumeRateLimit, rateLimit } from '../middleware/security';
import {
  MAX_PLACES_PER_DEVICE,
  hashInstallSecret,
  parseFcmToken,
  parseInstallId,
  parseInstallSecret,
  parseLocale,
  parsePlaceInput,
  parseUuid,
  secretMatches,
  trackedPlacesAvailable,
} from '../services/trackedPlaces';

/**
 * /api/places — "Takip ettiğim yerler" (app 1.2.0).
 *
 * No accounts: a device proves it owns its places with the install secret it
 * generated (X-Install-Id + X-Install-Secret headers; only the hash is
 * stored). Coordinates only ever arrive in request bodies, never in URLs, so
 * they cannot reach the access log.
 */
const router = Router();

const LAST_SEEN_REFRESH_MS = 60 * 60_000;

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ status: 'error', code, message });
}

async function requireTables(_req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await trackedPlacesAvailable(pool)) {
    next();
    return;
  }
  fail(res, 503, 'places_unavailable', 'Tracked places are not available yet');
}

async function requireDevice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const installId = parseInstallId(req.header('x-install-id'));
    const secret = parseInstallSecret(req.header('x-install-secret'));
    if (installId === null || secret === null) {
      fail(res, 401, 'unauthorized', 'Device credentials required');
      return;
    }
    const result = await pool.query(
      'SELECT secret_hash, last_seen_at FROM place_devices WHERE install_id = $1',
      [installId]
    );
    const row = result.rows[0];
    // Same answer for "unknown device" and "wrong secret".
    if (!row || !secretMatches(secret, row.secret_hash as Buffer)) {
      fail(res, 401, 'unauthorized', 'Device credentials required');
      return;
    }
    // last_seen_at drives the 90-day deletion; refreshing it at most hourly
    // keeps every request from becoming a write.
    if (Date.now() - new Date(row.last_seen_at).getTime() > LAST_SEEN_REFRESH_MS) {
      await pool.query('UPDATE place_devices SET last_seen_at = NOW() WHERE install_id = $1', [installId]);
    }
    res.locals.installId = installId;
    next();
  } catch (error) {
    console.error('places auth failed:', (error as Error).message);
    fail(res, 500, 'server_error', 'Unable to verify device');
  }
}

/** Per-device write budget, on top of the per-IP limits (mobile CGNAT shares IPs). */
function deviceWriteBudget(req: Request, res: Response, next: NextFunction): void {
  if (!consumeRateLimit(`places-write:${res.locals.installId}`, 30, 60 * 60_000)) {
    fail(res, 429, 'rate_limited', 'Too many requests');
    return;
  }
  next();
}

function serializePlace(row: any) {
  return {
    id: row.id,
    name: row.name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radius_km: Number(row.radius_m) / 1000,
    notify_heat: row.notify_heat,
    created_at: row.created_at,
    last_alert_at: row.last_alert_at ?? null,
  };
}

const PLACE_COLUMNS = `p.id, p.name, p.latitude, p.longitude, p.radius_m, p.notify_heat, p.created_at,
  (SELECT max(n.pushed_at) FROM place_notifications n WHERE n.place_id = p.id AND n.push_id IS NOT NULL) AS last_alert_at`;

/**
 * Point-in-Turkey on the same gate the ingest uses (1.5 km over land
 * borders, 5 km along the coast). Without country_borders the bbox check in
 * parsePlaceInput is all there is.
 */
async function insideTurkey(lat: number, lng: number): Promise<boolean> {
  const table = await pool.query(`SELECT to_regclass('public.country_borders') IS NOT NULL AS ok`);
  if (table.rows[0]?.ok !== true) return true;
  const result = await pool.query(
    `SELECT ST_Covers(geom_gate, ST_SetSRID(ST_MakePoint($1, $2), 4326)) AS inside
       FROM country_borders WHERE iso_a3 = 'TUR' LIMIT 1`,
    [lng, lat]
  );
  return result.rows.length === 0 ? true : result.rows[0].inside === true;
}

router.use(requireTables);

// POST /api/places/devices — register this install (idempotent for the same secret).
router.post('/devices', rateLimit('places-register', 10, 60 * 60_000), async (req: Request, res: Response) => {
  const installId = parseInstallId(req.body?.install_id);
  const secret = parseInstallSecret(req.body?.secret);
  const locale = req.body?.locale === undefined ? 'tr' : parseLocale(req.body.locale);
  const token = req.body?.fcm_token === undefined || req.body.fcm_token === null ? null : parseFcmToken(req.body.fcm_token);
  if (installId === null || secret === null) {
    fail(res, 400, 'invalid_device', 'install_id (UUID) and secret (32 bytes, base64url) are required');
    return;
  }
  if (locale === null) {
    fail(res, 400, 'invalid_locale', "locale must be 'tr' or 'en'");
    return;
  }
  if (req.body?.fcm_token != null && token === null) {
    fail(res, 400, 'invalid_token', 'fcm_token is invalid');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      'SELECT secret_hash FROM place_devices WHERE install_id = $1 FOR UPDATE',
      [installId]
    );
    if (existing.rows[0] && !secretMatches(secret, existing.rows[0].secret_hash)) {
      await client.query('ROLLBACK');
      fail(res, 409, 'install_id_taken', 'install_id is registered with another secret');
      return;
    }
    if (token !== null) {
      // A token belongs to one install; a reinstall that kept it takes it over.
      await client.query(
        'UPDATE place_devices SET fcm_token = NULL WHERE fcm_token = $1 AND install_id <> $2',
        [token, installId]
      );
    }
    await client.query(
      `INSERT INTO place_devices (install_id, secret_hash, fcm_token, locale)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (install_id) DO UPDATE SET
         fcm_token = COALESCE(EXCLUDED.fcm_token, place_devices.fcm_token),
         token_invalid_at = CASE WHEN EXCLUDED.fcm_token IS NULL THEN place_devices.token_invalid_at ELSE NULL END,
         locale = EXCLUDED.locale,
         last_seen_at = NOW()`,
      [installId, hashInstallSecret(secret), token, locale]
    );
    await client.query('COMMIT');
    res.status(existing.rows[0] ? 200 : 201).json({ status: 'success', data: { install_id: installId, max_places: MAX_PLACES_PER_DEVICE } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('places device register failed:', (error as Error).message);
    fail(res, 500, 'server_error', 'Unable to register device');
  } finally {
    client.release();
  }
});

// PATCH /api/places/devices/me — FCM token refresh and/or language change.
router.patch('/devices/me', rateLimit('places-device-patch', 60, 60 * 60_000), requireDevice, deviceWriteBudget, async (req: Request, res: Response) => {
  const installId = res.locals.installId as string;
  const hasToken = req.body?.fcm_token !== undefined;
  const token = hasToken ? parseFcmToken(req.body.fcm_token) : null;
  const locale = req.body?.locale === undefined ? null : parseLocale(req.body.locale);
  if (hasToken && token === null) {
    fail(res, 400, 'invalid_token', 'fcm_token is invalid');
    return;
  }
  if (req.body?.locale !== undefined && locale === null) {
    fail(res, 400, 'invalid_locale', "locale must be 'tr' or 'en'");
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (token !== null) {
      await client.query(
        'UPDATE place_devices SET fcm_token = NULL WHERE fcm_token = $1 AND install_id <> $2',
        [token, installId]
      );
    }
    await client.query(
      `UPDATE place_devices SET
         fcm_token = COALESCE($2, fcm_token),
         token_invalid_at = CASE WHEN $2::text IS NULL THEN token_invalid_at ELSE NULL END,
         locale = COALESCE($3, locale),
         last_seen_at = NOW()
       WHERE install_id = $1`,
      [installId, token, locale]
    );
    await client.query('COMMIT');
    res.json({ status: 'success' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('places device patch failed:', (error as Error).message);
    fail(res, 500, 'server_error', 'Unable to update device');
  } finally {
    client.release();
  }
});

// DELETE /api/places/devices/me — "Konum verimi sil": the device and every place go.
router.delete('/devices/me', rateLimit('places-device-delete', 10, 60 * 60_000), requireDevice, async (_req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM place_devices WHERE install_id = $1', [res.locals.installId]);
    res.json({ status: 'success', data: { deleted: true } });
  } catch (error) {
    console.error('places device delete failed:', (error as Error).message);
    fail(res, 500, 'server_error', 'Unable to delete device data');
  }
});

// GET /api/places — this device's places.
router.get('/', rateLimit('places-list', 120, 60 * 60_000), requireDevice, async (_req: Request, res: Response) => {
  try {
    const result = await pool.query(
      `SELECT ${PLACE_COLUMNS} FROM tracked_places p WHERE p.install_id = $1 ORDER BY p.created_at`,
      [res.locals.installId]
    );
    res.json({ status: 'success', data: result.rows.map(serializePlace), max_places: MAX_PLACES_PER_DEVICE });
  } catch (error) {
    console.error('places list failed:', (error as Error).message);
    fail(res, 500, 'server_error', 'Unable to load places');
  }
});

// POST /api/places — add a place (max 5 per device).
router.post('/', rateLimit('places-add', 60, 60 * 60_000), requireDevice, deviceWriteBudget, async (req: Request, res: Response) => {
  const input = parsePlaceInput(req.body);
  if (input === 'outside_turkey') {
    fail(res, 422, 'outside_turkey', 'The place must be in Turkey');
    return;
  }
  if (typeof input === 'string') {
    fail(res, 400, 'invalid_place', input);
    return;
  }
  const installId = res.locals.installId as string;
  const client = await pool.connect();
  try {
    if (!(await insideTurkey(input.latitude, input.longitude))) {
      fail(res, 422, 'outside_turkey', 'The place must be in Turkey');
      return;
    }
    await client.query('BEGIN');
    // Locking the device row serialises concurrent adds, so the count holds.
    await client.query('SELECT 1 FROM place_devices WHERE install_id = $1 FOR UPDATE', [installId]);
    const count = await client.query('SELECT count(*)::int AS n FROM tracked_places WHERE install_id = $1', [installId]);
    if (count.rows[0].n >= MAX_PLACES_PER_DEVICE) {
      await client.query('ROLLBACK');
      fail(res, 409, 'place_limit', `At most ${MAX_PLACES_PER_DEVICE} places per device`);
      return;
    }
    const inserted = await client.query(
      `INSERT INTO tracked_places (install_id, name, latitude, longitude, radius_m, notify_heat)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, latitude, longitude, radius_m, notify_heat, created_at, NULL::timestamptz AS last_alert_at`,
      [installId, input.name, input.latitude, input.longitude, input.radiusM, input.notifyHeat]
    );
    await client.query('COMMIT');
    res.status(201).json({ status: 'success', data: serializePlace(inserted.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('places add failed:', (error as Error).message);
    fail(res, 500, 'server_error', 'Unable to add place');
  } finally {
    client.release();
  }
});

// PATCH /api/places/:id — per-place alert switch. Name and radius are not
// editable in 1.2.0 (delete and add again).
router.patch('/:id', rateLimit('places-patch', 120, 60 * 60_000), requireDevice, deviceWriteBudget, async (req: Request, res: Response) => {
  const placeId = parseUuid(req.params.id);
  if (placeId === null) {
    fail(res, 404, 'not_found', 'Place not found');
    return;
  }
  if (typeof req.body?.notify_heat !== 'boolean') {
    fail(res, 400, 'invalid_place', 'notify_heat must be a boolean');
    return;
  }
  try {
    const result = await pool.query(
      `UPDATE tracked_places p SET notify_heat = $3, updated_at = NOW()
       WHERE p.id = $1 AND p.install_id = $2
       RETURNING ${PLACE_COLUMNS}`,
      [placeId, res.locals.installId, req.body.notify_heat]
    );
    if (result.rowCount === 0) {
      fail(res, 404, 'not_found', 'Place not found');
      return;
    }
    res.json({ status: 'success', data: serializePlace(result.rows[0]) });
  } catch (error) {
    console.error('places patch failed:', (error as Error).message);
    fail(res, 500, 'server_error', 'Unable to update place');
  }
});

// DELETE /api/places/:id
router.delete('/:id', rateLimit('places-delete', 120, 60 * 60_000), requireDevice, async (req: Request, res: Response) => {
  const placeId = parseUuid(req.params.id);
  if (placeId === null) {
    fail(res, 404, 'not_found', 'Place not found');
    return;
  }
  try {
    const result = await pool.query(
      'DELETE FROM tracked_places WHERE id = $1 AND install_id = $2',
      [placeId, res.locals.installId]
    );
    if (result.rowCount === 0) {
      fail(res, 404, 'not_found', 'Place not found');
      return;
    }
    res.json({ status: 'success', data: { deleted: true } });
  } catch (error) {
    console.error('places delete failed:', (error as Error).message);
    fail(res, 500, 'server_error', 'Unable to delete place');
  }
});

export default router;
