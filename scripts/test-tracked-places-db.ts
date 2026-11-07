/**
 * Runs migration 014 and the tracked-place alert SQL against a real PostGIS
 * database, inside one transaction that is always rolled back.
 *
 *   TEST_DATABASE_URL=postgres://... npm run test:tracked-places-db
 *
 * Use a throwaway database (a local postgis/postgis container, or a Neon
 * branch). It refuses to run against the DATABASE_URL in .env. Everything is
 * created in a temporary schema `tp_test` that shadows public, including a
 * minimal fire_incidents, so nothing outside it is read or written.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('TEST_DATABASE_URL not set — skipping (needs PostGIS).');
  process.exit(0);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ path: join(__dirname, '..', '.env'), quiet: true });
const prodHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : null;
if (prodHost && new URL(url).host === prodHost) {
  console.error('Refusing to run: TEST_DATABASE_URL points at the production database.');
  process.exit(1);
}
// The job module builds its pool from DATABASE_URL on import; aim it nowhere.
process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { newHeatPairsSql } = require('../src/jobs/placeAlertJob') as typeof import('../src/jobs/placeAlertJob');

let failures = 0;
async function b(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
}

const migration = readFileSync(join(__dirname, '..', 'database', 'migrations', '014_tracked_places.sql'), 'utf8')
  .split('\n')
  .filter((l) => !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
  .join('\n');

// A point `km` kilometres north of (lat, lng).
const north = (lat: number, km: number) => lat + km / 111.32;

(async () => {
  const c = new Client({ connectionString: url, ssl: url.includes('sslmode') ? { rejectUnauthorized: false } : undefined });
  await c.connect();
  await c.query('BEGIN');
  try {
    await c.query('CREATE SCHEMA tp_test');
    await c.query('SET LOCAL search_path = tp_test, public');
    await c.query(`CREATE TABLE fire_incidents (
      id BIGSERIAL PRIMARY KEY,
      centroid geometry(Point, 4326) NOT NULL,
      last_detected_at TIMESTAMPTZ NOT NULL,
      peak_confidence_tier TEXT,
      distinct_days_seen INTEGER NOT NULL DEFAULT 1,
      frp_mean NUMERIC,
      max_frp_mw NUMERIC
    )`);

    await b('migration 014 applies', async () => {
      await c.query(migration);
      const r = await c.query(`SELECT to_regclass('tp_test.tracked_places') IS NOT NULL AS ok`);
      assert.ok(r.rows[0].ok);
    });

    const dev = '11111111-1111-4111-8111-111111111111';
    const dev2 = '22222222-2222-4222-8222-222222222222';
    await c.query(`INSERT INTO place_devices (install_id, secret_hash, fcm_token, locale) VALUES
      ($1, decode(repeat('ab', 32), 'hex'), 'token-device-one-xxxxxxxx', 'tr'),
      ($2, decode(repeat('cd', 32), 'hex'), 'token-device-two-xxxxxxxx', 'en')`, [dev, dev2]);

    await b('stored coordinates can never be finer than 2 decimals', async () => {
      const r = await c.query(
        `INSERT INTO tracked_places (install_id, name, latitude, longitude, radius_m)
         VALUES ($1, 'Probe', 38.42349, 27.14281, 5000) RETURNING latitude::text, longitude::text,
         ST_Y(geom::geometry) AS gy, ST_X(geom::geometry) AS gx`, [dev]);
      assert.deepStrictEqual([r.rows[0].latitude, r.rows[0].longitude], ['38.42', '27.14']);
      assert.ok(Math.abs(r.rows[0].gy - 38.42) < 1e-9 && Math.abs(r.rows[0].gx - 27.14) < 1e-9);
      await c.query(`DELETE FROM tracked_places WHERE name = 'Probe'`);
    });

    await b('checks reject bad radius, empty name, short secret', async () => {
      for (const sql of [
        `INSERT INTO tracked_places (install_id, name, latitude, longitude, radius_m) VALUES ('${dev}', 'x', 38.4, 27.1, 7000)`,
        `INSERT INTO tracked_places (install_id, name, latitude, longitude, radius_m) VALUES ('${dev}', '   ', 38.4, 27.1, 5000)`,
        `INSERT INTO place_devices (install_id, secret_hash) VALUES ('33333333-3333-4333-8333-333333333333', '\\x00')`,
      ]) {
        await c.query('SAVEPOINT s');
        await assert.rejects(c.query(sql));
        await c.query('ROLLBACK TO SAVEPOINT s');
      }
    });

    // Place A: İzmir, 10 km. Place B (device 2): Antalya, 25 km, far from everything.
    const A = await c.query(`INSERT INTO tracked_places (install_id, name, latitude, longitude, radius_m)
      VALUES ($1, 'Ev', 38.42, 27.14, 10000) RETURNING id`, [dev]);
    await c.query(`INSERT INTO tracked_places (install_id, name, latitude, longitude, radius_m)
      VALUES ($1, 'Home', 36.90, 30.70, 25000)`, [dev2]);
    const placeA = A.rows[0].id;

    const incident = async (km: number, tier: string, hoursAgo: number, heatSource = false) => {
      const r = await c.query(
        `INSERT INTO fire_incidents (centroid, last_detected_at, peak_confidence_tier, distinct_days_seen, frp_mean, max_frp_mw)
         VALUES (ST_SetSRID(ST_MakePoint(27.14, $1), 4326), NOW() - make_interval(hours => $2), $3, $4, $5, $6) RETURNING id`,
        [north(38.42, km), hoursAgo, tier, heatSource ? 9 : 1, heatSource ? 2 : 30, heatSource ? 6 : 40]
      );
      return String(r.rows[0].id);
    };
    const inside = await incident(8, 'nominal', 1);
    const lowConf = await incident(5, 'low', 1);
    await incident(6, 'high', 13); // too old
    await incident(4, 'high', 1, true); // persistent heat source
    await incident(12, 'high', 1); // outside 10 km

    await b('only the in-radius, recent, nominal/high, non-heat-source incident pairs', async () => {
      const r = await c.query(newHeatPairsSql());
      assert.strictEqual(r.rowCount, 1, JSON.stringify(r.rows));
      const row = r.rows[0];
      assert.strictEqual(row.place_id, placeA);
      assert.strictEqual(row.incident_id, inside);
      assert.strictEqual(row.place_name, 'Ev');
      assert.strictEqual(row.locale, 'tr');
      assert.strictEqual(row.fcm_token, 'token-device-one-xxxxxxxx');
      assert.ok(Math.abs(Number(row.distance_m) - 8000) < 150, `distance ${row.distance_m}`);
      assert.strictEqual(row.recent_delivered, 0);
    });

    await b('the same pair never comes back (one alert per incident)', async () => {
      const r = await c.query(newHeatPairsSql());
      assert.strictEqual(r.rowCount, 0);
    });

    await b('a low-confidence incident alerts once it reaches nominal', async () => {
      await c.query(`UPDATE fire_incidents SET peak_confidence_tier = 'nominal' WHERE id = $1`, [lowConf]);
      const r = await c.query(newHeatPairsSql());
      assert.deepStrictEqual(r.rows.map((x) => x.incident_id), [lowConf]);
    });

    await b('delivered rows count toward the device cap', async () => {
      await c.query(`UPDATE place_notifications SET delivered = true WHERE install_id = $1`, [dev]);
      await incident(3, 'high', 0);
      const r = await c.query(newHeatPairsSql());
      assert.strictEqual(r.rowCount, 1);
      assert.strictEqual(r.rows[0].recent_delivered, 2);
    });

    await b('a place with alerts off records nothing', async () => {
      await c.query(`UPDATE tracked_places SET notify_heat = false WHERE id = $1`, [placeA]);
      await incident(2, 'high', 0);
      const r = await c.query(newHeatPairsSql());
      assert.strictEqual(r.rowCount, 0);
    });

    await b('deleting the device deletes its places and alert records', async () => {
      await c.query('DELETE FROM place_devices WHERE install_id = $1', [dev]);
      const r = await c.query(
        `SELECT (SELECT count(*) FROM tracked_places WHERE install_id = $1)::int AS places,
                (SELECT count(*) FROM place_notifications WHERE install_id = $1)::int AS alerts`, [dev]);
      assert.deepStrictEqual(r.rows[0], { places: 0, alerts: 0 });
    });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  if (failures > 0) { console.log(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nall passed (rolled back)');
})().catch((e) => { console.error(e); process.exit(1); });
