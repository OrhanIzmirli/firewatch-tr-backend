/**
 * Tracked places (app 1.2.0) without a database: validation, credentials,
 * alert wording, per-device grouping and cap, and the shape of the SQL and
 * migration the alerts and the privacy promises rely on.
 *
 *   npm run test:tracked-places
 *
 * The SQL itself is exercised against PostGIS by scripts/test-tracked-places-db.ts.
 */
import assert from 'node:assert';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HEAT_ALERT_DEVICE_CAP,
  MAX_PLACES_PER_DEVICE,
  buildHeatAlertText,
  hashInstallSecret,
  normalizePlaceName,
  parseInstallSecret,
  parseLocale,
  parsePlaceInput,
  parseUuid,
  secretMatches,
} from '../src/services/trackedPlaces';

// The job module creates the pg pool on import. Point it at an address that
// cannot answer so this test can never reach a real database; nothing here
// runs a query.
process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildPushMessage, newHeatPairsSql, planDevicePushes } = require('../src/jobs/placeAlertJob') as typeof import('../src/jobs/placeAlertJob');

let failures = 0;
const b = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

b('limits: 5 places, radii 5/10/25', () => {
  assert.strictEqual(MAX_PLACES_PER_DEVICE, 5);
  for (const r of [5, 10, 25]) assert.ok(typeof parsePlaceInput({ name: 'Ev', latitude: 38.4, longitude: 27.1, radius_km: r }) === 'object');
  for (const r of [0, 1, 7, 50, '10x', null]) {
    assert.match(String(parsePlaceInput({ name: 'Ev', latitude: 38.4, longitude: 27.1, radius_km: r })), /radius_km/);
  }
});

b('place coordinates are rounded to ~1 km before anything else', () => {
  const p = parsePlaceInput({ name: 'Ev', latitude: 38.423456, longitude: 27.142899, radius_km: 10 });
  assert.ok(typeof p === 'object');
  assert.deepStrictEqual([p.latitude, p.longitude, p.radiusM, p.notifyHeat], [38.42, 27.14, 10000, true]);
});

b('outside Turkey is its own error', () => {
  assert.strictEqual(parsePlaceInput({ name: 'Atina', latitude: 37.98, longitude: 23.72, radius_km: 5 }), 'outside_turkey');
  assert.strictEqual(parsePlaceInput({ name: 'x', latitude: 'a', longitude: 1, radius_km: 5 }), 'latitude and longitude are required');
});

b('names: trimmed, one-spaced, no control/bidi characters, 1-40 chars', () => {
  assert.strictEqual(normalizePlaceName('  Yazlık   ev  '), 'Yazlık ev');
  assert.strictEqual(normalizePlaceName('Ev‮gnirts\u0007'), 'Evgnirts');
  assert.strictEqual(normalizePlaceName('   '), null);
  assert.strictEqual(normalizePlaceName('ş'.repeat(40)), 'ş'.repeat(40));
  assert.strictEqual(normalizePlaceName('ş'.repeat(41)), null);
  assert.strictEqual(normalizePlaceName(42), null);
});

b('notify_heat must be a boolean when given', () => {
  assert.match(String(parsePlaceInput({ name: 'Ev', latitude: 38.4, longitude: 27.1, radius_km: 5, notify_heat: 'yes' })), /notify_heat/);
  const off = parsePlaceInput({ name: 'Ev', latitude: 38.4, longitude: 27.1, radius_km: 5, notify_heat: false });
  assert.ok(typeof off === 'object' && off.notifyHeat === false);
});

b('install secret: exactly 32 random bytes, base64url; only its hash is compared', () => {
  const secret = crypto.randomBytes(32);
  const encoded = secret.toString('base64url');
  assert.strictEqual(encoded.length, 43);
  assert.deepStrictEqual(parseInstallSecret(encoded), secret);
  assert.strictEqual(parseInstallSecret(encoded.slice(0, 42)), null);
  assert.strictEqual(parseInstallSecret(crypto.randomBytes(16).toString('base64url')), null);
  assert.strictEqual(parseInstallSecret(encoded.replace(/./, '+')), null);
  const stored = hashInstallSecret(secret);
  assert.ok(secretMatches(secret, stored));
  assert.ok(!secretMatches(crypto.randomBytes(32), stored));
  assert.ok(!secretMatches(secret, Buffer.alloc(31)));
});

b('ids and locale', () => {
  assert.strictEqual(parseUuid('3F2504E0-4F89-41D3-9A0C-0305E82C3301'), '3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  assert.strictEqual(parseUuid('not-a-uuid'), null);
  assert.strictEqual(parseUuid("1' OR '1'='1"), null);
  assert.strictEqual(parseLocale('tr'), 'tr');
  assert.strictEqual(parseLocale('de'), null);
});

b('alert text: place, distance, "not a confirmed fire", 112 — both languages', () => {
  const tr = buildHeatAlertText('tr', 'Ev', 8400, 0);
  assert.match(tr.title, /Ev yakınında ısı tespiti/);
  assert.match(tr.body, /≈8 km/);
  assert.match(tr.body, /doğrulanmış bir yangın değildir/);
  assert.match(tr.body, /112/);
  const en = buildHeatAlertText('en', 'Home', 300, 2);
  assert.match(en.body, /~1 km/);
  assert.match(en.body, /not a confirmed fire/);
  assert.match(en.body, /call 112/);
  assert.match(en.body, /\+2 more detections/);
  assert.match(buildHeatAlertText('tr', 'Ev', 5000, 1).body, /\+1 tespit daha/);
});

const pair = (over: Partial<any>): any => ({
  place_id: 'p1', install_id: 'd1', incident_id: '100', place_name: 'Ev', distance_m: 9000,
  fcm_token: 'tok-d1-xxxxxxxxxxxxxxxx', locale: 'tr', recent_delivered: 0, ...over,
});

b('one push per device, naming the nearest place/incident', () => {
  const { pushes } = planDevicePushes([
    pair({ place_id: 'p1', incident_id: '100', distance_m: 9000 }),
    pair({ place_id: 'p2', incident_id: '101', distance_m: 2000, place_name: 'Bağ evi' }),
    pair({ install_id: 'd2', fcm_token: 'tok-d2-xxxxxxxxxxxxxxxx', locale: 'en' }),
  ]);
  assert.strictEqual(pushes.length, 2);
  const d1 = pushes.find((p) => p.installId === 'd1')!;
  assert.strictEqual(d1.nearest.place_name, 'Bağ evi');
  assert.strictEqual(d1.extra, 1);
  assert.strictEqual(pushes.find((p) => p.installId === 'd2')!.locale, 'en');
});

b('two places seeing the same incident are one fire, not "+1"', () => {
  const { pushes } = planDevicePushes([
    pair({ place_id: 'p1', incident_id: '100', distance_m: 4000 }),
    pair({ place_id: 'p2', incident_id: '100', distance_m: 6000 }),
  ]);
  assert.strictEqual(pushes[0].extra, 0);
});

b('device cap and missing token suppress the push', () => {
  const { pushes, capped } = planDevicePushes([
    pair({ install_id: 'capped', recent_delivered: HEAT_ALERT_DEVICE_CAP }),
    pair({ install_id: 'no-token', fcm_token: null }),
    pair({ install_id: 'ok', recent_delivered: HEAT_ALERT_DEVICE_CAP - 1 }),
  ]);
  assert.deepStrictEqual(pushes.map((p) => p.installId), ['ok']);
  assert.strictEqual(capped, 1);
});

b('push message: places channel, per-incident tag, 6 h TTL, deep-link data', () => {
  const { pushes } = planDevicePushes([pair({ incident_id: '777', place_id: 'p9' })]);
  const m = buildPushMessage(pushes[0]);
  assert.strictEqual(m.androidChannelId, 'firewatch_places');
  assert.strictEqual(m.tag, 'incident-777');
  assert.strictEqual(m.ttlSeconds, 21600);
  assert.deepStrictEqual(m.data, { type: 'place_heat', place_id: 'p9', incident_id: '777' });
});

const sql = newHeatPairsSql();
b('alert SQL: radius, 12 h, nominal/high only, no heat sources, one row per pair', () => {
  assert.match(sql, /ST_DWithin\(p\.geom, i\.centroid::geography, p\.radius_m\)/);
  assert.match(sql, /i\.last_detected_at > NOW\(\) - make_interval\(hours => 12\)/);
  assert.match(sql, /i\.peak_confidence_tier IN \('nominal', 'high'\)/);
  assert.match(sql, /AND NOT COALESCE\(\(i\.distinct_days_seen >= 7/);
  assert.match(sql, /WHERE p\.notify_heat/);
  assert.match(sql, /ON CONFLICT \(place_id, kind, ref_key\) DO NOTHING\s+RETURNING/);
});

const m014 = src('database/migrations/014_tracked_places.sql');
b('migration 014: additive, ~1 km columns, cascade, checks', () => {
  // Only commented-out DROPs (the documented rollback) may appear.
  assert.doesNotMatch(m014, /^\s*(DROP|ALTER|DELETE|UPDATE|TRUNCATE)\b/im);
  assert.match(m014, /latitude\s+NUMERIC\(5, 2\) NOT NULL/);
  assert.match(m014, /longitude\s+NUMERIC\(5, 2\) NOT NULL/);
  assert.match(m014, /REFERENCES place_devices \(install_id\) ON DELETE CASCADE/);
  assert.match(m014, /REFERENCES tracked_places \(id\) ON DELETE CASCADE/);
  assert.match(m014, /CHECK \(radius_m IN \(5000, 10000, 25000\)\)/);
  assert.match(m014, /secret_hash\s+BYTEA NOT NULL CHECK \(octet_length\(secret_hash\) = 32\)/);
  assert.match(m014, /PRIMARY KEY \(place_id, kind, ref_key\)/);
  assert.match(m014, /GENERATED ALWAYS AS/);
  assert.match(m014, /^BEGIN;$/m);
  assert.match(m014, /^COMMIT;$/m);
});

const routes = src('src/routes/places.ts');
b('routes: every route but registration needs the device secret; no coordinates in URLs', () => {
  const lines = routes.split('\n').filter((l) => /^router\.(get|post|patch|delete)\(/.test(l));
  assert.strictEqual(lines.length, 7);
  for (const l of lines) {
    if (l.includes("router.post('/devices'")) continue;
    assert.match(l, /requireDevice/, l);
  }
  assert.doesNotMatch(routes, /req\.query/);
  assert.match(routes, /FOR UPDATE[\s\S]*count\(\*\)::int AS n FROM tracked_places/);
  assert.match(routes, /WHERE p\.id = \$1 AND p\.install_id = \$2/);
  assert.match(routes, /DELETE FROM tracked_places WHERE id = \$1 AND install_id = \$2/);
  assert.match(routes, /DELETE FROM place_devices WHERE install_id = \$1/);
});

const retention = src('src/jobs/privacyRetentionJob.ts');
b('retention: devices after 90 days or 7 days with a dead token; alert records after 30', () => {
  assert.match(retention, /DELETE FROM place_devices\s+WHERE last_seen_at < NOW\(\) - make_interval\(days => \$1\)\s+OR \(fcm_token IS NULL AND token_invalid_at < NOW\(\) - make_interval\(days => \$2\)\)/);
  assert.match(retention, /DEAD_TOKEN_GRACE_DAYS = 7/);
  assert.match(retention, /PLACE_NOTIFICATION_RETENTION_DAYS = 30/);
  assert.match(retention, /const placesReady = await trackedPlacesAvailable\(pool\);\s+const client = await pool\.connect\(\);/);
});

b('ingest runs the place alerts after clustering', () => {
  assert.match(src('src/jobs/fireIngestJob.ts'), /await fireClusterJob\.runClustering\(\);[\s\S]{0,200}await placeAlertJob\.run\(\);/);
  assert.match(src('src/server.ts'), /app\.use\('\/api\/places', placesRoutes\)/);
});

b('privacy policy describes tracked places in both languages', () => {
  const legal = src('src/routes/legal.ts');
  assert.match(legal, /Takip ettiğin yerler: verdiğin ad, yaklaşık 1 km/);
  assert.match(legal, /Your tracked places: the name you give, location rounded to about 1 km/);
  assert.match(legal, /tüm takip ettiğiniz yerleri hemen siler/);
  assert.match(legal, /all your tracked places from our server immediately/);
});

if (failures > 0) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
