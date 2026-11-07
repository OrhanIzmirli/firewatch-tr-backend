/**
 * Checks the location rules of utils/locationPrivacy.ts and that every
 * write path follows them, without a database.
 *
 *   npm run test:location-privacy
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RETENTION_DAYS,
  STORED_COORDINATE_DECIMALS,
  isDeadTokenError,
  redactLocationInUrl,
  roundStoredCoordinate,
} from '../src/utils/locationPrivacy';

let failures = 0;
const b = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

b('stored coordinates keep 2 decimals (~1 km)', () => {
  assert.strictEqual(STORED_COORDINATE_DECIMALS, 2);
  assert.strictEqual(roundStoredCoordinate(38.423456), 38.42);
  assert.strictEqual(roundStoredCoordinate(27.142899), 27.14);
  assert.strictEqual(roundStoredCoordinate(36.9876), 36.99);
  assert.strictEqual(roundStoredCoordinate(-0.004), -0);
  assert.strictEqual(roundStoredCoordinate(null), null);
  assert.strictEqual(roundStoredCoordinate(Number.NaN), null);
});

b('rounding moves a point by well under 1 km anywhere in Türkiye', () => {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  let worst = 0;
  for (let lat = 35.8; lat <= 42.2; lat += 0.0137) {
    for (let lng = 25.6; lng <= 44.8; lng += 0.0731) {
      const rl = roundStoredCoordinate(lat)!;
      const rg = roundStoredCoordinate(lng)!;
      const dy = toRad(rl - lat) * R;
      const dx = toRad(rg - lng) * R * Math.cos(toRad(lat));
      worst = Math.max(worst, Math.hypot(dx, dy));
    }
  }
  assert.ok(worst < 800, `worst shift ${worst.toFixed(0)} m`);
});

b('retention is 90 days', () => assert.strictEqual(RETENTION_DAYS, 90));

b('coordinates are redacted from logged URLs', () => {
  assert.strictEqual(
    redactLocationInUrl('/api/fires/nearest-city?lat=38.4234&lng=27.1428'),
    '/api/fires/nearest-city?lat=redacted&lng=redacted'
  );
  assert.strictEqual(
    redactLocationInUrl('/x?Latitude=1&longitude=2&lon=3&limit=50'),
    '/x?Latitude=redacted&longitude=redacted&lon=redacted&limit=50'
  );
  assert.strictEqual(redactLocationInUrl('/api/news?limit=20&offset=0'), '/api/news?limit=20&offset=0');
  assert.strictEqual(redactLocationInUrl('/api/health'), '/api/health');
  assert.strictEqual(redactLocationInUrl('/a?%6Cat=1'), '/a?%6Cat=redacted');
  assert.strictEqual(redactLocationInUrl('/a?lat=%E0%A4%A&lng'), '/a?lat=redacted&lng=redacted');
  assert.strictEqual(redactLocationInUrl(undefined), '-');
});

b('only token-is-dead FCM errors erase a device', () => {
  assert.ok(isDeadTokenError('messaging/registration-token-not-registered'));
  assert.ok(isDeadTokenError('messaging/invalid-registration-token'));
  assert.ok(!isDeadTokenError('messaging/invalid-argument'));
  assert.ok(!isDeadTokenError('messaging/internal-error'));
  assert.ok(!isDeadTokenError(undefined));
});

const controller = src('src/controllers/notificationController.ts');
const service = src('src/services/notificationService.ts');
const fires = src('src/routes/fires.ts');
const server = src('src/server.ts');
const job = src('src/jobs/privacyRetentionJob.ts');
const routes = src('src/routes/notifications.ts');

b('subscribe stores only rounded coordinates', () => {
  assert.match(controller, /roundStoredCoordinate\(lat\),\s+roundStoredCoordinate\(lng\),\s+scope\.alertScope/);
});

b('PATCH stores rounded coordinates and erases them when turned off', () => {
  assert.match(controller, /latitude\s+= CASE WHEN \$2 THEN COALESCE\(\$3, latitude\)\s+ELSE NULL END/);
  assert.match(controller, /longitude = CASE WHEN \$2 THEN COALESCE\(\$4, longitude\) ELSE NULL END/);
  assert.match(controller, /is_active,\s+roundStoredCoordinate\(lat\),\s+roundStoredCoordinate\(lng\),/);
});

b('unsubscribe erases the location', () => {
  assert.match(controller, /SET is_active = false, latitude = NULL, longitude = NULL, updated_at = NOW\(\)\s+WHERE token = \$1/);
});

b('"delete my location" route exists and erases only the location', () => {
  assert.match(routes, /router\.post\('\/location\/delete', rateLimit\(/);
  assert.match(controller, /SET latitude = NULL, longitude = NULL, updated_at = NOW\(\)\s+WHERE token = \$1`/);
});

b('no write path stores a raw lat/lng in fcm_tokens', () => {
  // Every parameter list feeding an fcm_tokens write goes through rounding.
  assert.doesNotMatch(controller, /'android',\s+lat,\s+lng,/);
  assert.doesNotMatch(controller, /\[token, is_active, lat, lng,/);
});

b('FCM dead tokens are deactivated and lose their location', () => {
  assert.match(service, /SET is_active = false, latitude = NULL, longitude = NULL\s+WHERE token = ANY\(\$1::text\[\]\)/);
  assert.match(service, /isDeadTokenError\(r\.error\?\.code\)\) deadTokens\.push\(batch\[i\]\)/);
  assert.match(service, /if \(isDeadTokenError\(code\)\) await forgetDeadTokens\(\[token\]\)/);
});

b('fire reports store rounded coordinates', () => {
  assert.match(fires, /description \?\? '',\s+roundStoredCoordinate\(lat\),\s+roundStoredCoordinate\(lng\),/);
});

b('access log uses the redacting URL token', () => {
  assert.match(server, /morgan\.token\('safe-url'/);
  assert.doesNotMatch(server, /morgan\([^)]*'combined'/);
  assert.doesNotMatch(server, /:url\b/);
  assert.match(server, /privacyRetentionJob\.start\(\)/);
});

b('retention job deletes devices and reports after RETENTION_DAYS, in one transaction', () => {
  assert.match(job, /DELETE FROM fcm_tokens\s+WHERE COALESCE\(updated_at, created_at\) < NOW\(\) - make_interval\(days => \$1\)/);
  assert.match(job, /DELETE FROM fire_reports\s+WHERE created_at < NOW\(\) - make_interval\(days => \$1\)/);
  assert.match(job, /client\.query\('BEGIN'\)[\s\S]*client\.query\('COMMIT'\)/);
  assert.match(job, /WHERE is_active = false AND \(latitude IS NOT NULL OR longitude IS NOT NULL\)/);
});

if (failures > 0) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall passed');
