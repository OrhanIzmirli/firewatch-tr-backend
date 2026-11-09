/**
 * Runs migration 014 and the whole tracked-place alert pass (runPlaceAlerts,
 * with a fake FCM sender) against a real PostGIS database, inside one
 * transaction that is always rolled back.
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
const job = require('../src/jobs/placeAlertJob') as typeof import('../src/jobs/placeAlertJob');
type PushMessage = import('../src/services/notificationService').PushMessage;
type PushResult = import('../src/services/notificationService').PushResult;

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

/** Fake FCM: records every message; per-token outcome scripted. */
const sent: PushMessage[] = [];
const outcome = new Map<string, PushResult>();
const send = async (messages: PushMessage[]): Promise<PushResult[]> => {
  sent.push(...messages);
  return messages.map((m) => outcome.get(m.token) ?? { success: true, deadToken: false });
};

(async () => {
  const c = new Client({ connectionString: url });
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
      max_frp_mw NUMERIC,
      land_cover TEXT,
      news_verified_id BIGINT
    )`);
    const run = () => job.runPlaceAlerts(c, send, { forgetFcmTokens: false });
    const statuses = async (install: string) =>
      (await c.query(`SELECT status, count(*)::int AS n FROM place_notifications WHERE install_id = $1 GROUP BY 1 ORDER BY 1`, [install]))
        .rows.map((r) => `${r.status}:${r.n}`).join(' ');

    await b('migration 014 applies', async () => {
      await c.query(migration);
      const r = await c.query(`SELECT to_regclass('tp_test.tracked_places') IS NOT NULL AS ok`);
      assert.ok(r.rows[0].ok);
    });

    const dev = '11111111-1111-4111-8111-111111111111';
    const dev2 = '22222222-2222-4222-8222-222222222222';
    const tok1 = 'token-device-one-xxxxxxxx';
    await c.query(`INSERT INTO place_devices (install_id, secret_hash, fcm_token, locale) VALUES
      ($1, decode(repeat('ab', 32), 'hex'), $3, 'tr'),
      ($2, decode(repeat('cd', 32), 'hex'), 'token-device-two-xxxxxxxx', 'en')`, [dev, dev2, tok1]);

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

    // Place A: İzmir, 10 km (device 1, Turkish). Place B: Antalya, 25 km (device 2).
    const A = await c.query(`INSERT INTO tracked_places (install_id, name, latitude, longitude, radius_m)
      VALUES ($1, 'Ev', 38.42, 27.14, 10000) RETURNING id`, [dev]);
    await c.query(`INSERT INTO tracked_places (install_id, name, latitude, longitude, radius_m)
      VALUES ($1, 'Home', 36.90, 30.70, 25000)`, [dev2]);
    const placeA = A.rows[0].id;

    await b('a sent/summarized row must carry push_id and pushed_at, and only those may', async () => {
      for (const sql of [
        `INSERT INTO place_notifications (place_id, kind, ref_key, install_id, status) VALUES ('${placeA}', 'heat', 'x1', '${dev}', 'sent')`,
        `INSERT INTO place_notifications (place_id, kind, ref_key, install_id, status, push_id, pushed_at) VALUES ('${placeA}', 'heat', 'x2', '${dev}', 'held', gen_random_uuid(), NOW())`,
        `INSERT INTO place_notifications (place_id, kind, ref_key, install_id, status) VALUES ('${placeA}', 'heat', 'x3', '${dev}', 'dropped')`,
      ]) {
        await c.query('SAVEPOINT s');
        await assert.rejects(c.query(sql), sql);
        await c.query('ROLLBACK TO SAVEPOINT s');
      }
    });

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

    await b('push 1: only the in-radius, recent, nominal/high, non-heat-source incident', async () => {
      const stats = await run();
      assert.strictEqual(stats.newPairs, 1);
      assert.strictEqual(stats.pushesSent, 1);
      assert.strictEqual(sent.length, 1);
      const m = sent[0];
      assert.strictEqual(m.token, tok1);
      assert.match(m.title, /Ev yakınında ısı tespiti/);
      assert.match(m.body, /≈8 km/);
      assert.strictEqual(m.data!.type, 'place_heat');
      assert.strictEqual(m.data!.incident_id, inside);
      assert.ok(Math.abs(Number(m.data!.lat) - north(38.42, 8)) < 1e-3);
      assert.strictEqual(await statuses(dev), 'sent:1');
    });

    await b('the same incident never alerts again', async () => {
      const stats = await run();
      assert.strictEqual(stats.newPairs, 0);
      assert.strictEqual(sent.length, 1);
    });

    await b('push 2: a low-confidence incident alerts once it reaches nominal', async () => {
      await c.query(`UPDATE fire_incidents SET peak_confidence_tier = 'nominal' WHERE id = $1`, [lowConf]);
      await run();
      assert.strictEqual(sent.length, 2);
      assert.strictEqual(sent[1].data!.incident_id, lowConf);
    });

    await b('push 3 carries two detections; the cap counts it as one push', async () => {
      const a = await incident(3, 'high', 0);
      const b2 = await incident(2, 'high', 0);
      const stats = await run();
      assert.strictEqual(stats.pushesSent, 1);
      assert.strictEqual(sent.length, 3);
      assert.match(sent[2].body, /\+1 tespit daha/);
      assert.ok([a, b2].includes(sent[2].data!.incident_id));
      const pushes = await c.query(`SELECT count(DISTINCT push_id)::int AS n FROM place_notifications WHERE install_id = $1`, [dev]);
      assert.strictEqual(pushes.rows[0].n, 3);
      assert.strictEqual(await statuses(dev), 'sent:4');
    });

    await b('over the cap (3 pushes / 6 h): new detections are held, nothing is sent', async () => {
      await incident(1, 'high', 0);
      await incident(1.5, 'nominal', 0);
      let stats = await run();
      assert.strictEqual(stats.held, 2);
      assert.strictEqual(sent.length, 3);
      await incident(0.5, 'high', 0);
      stats = await run();
      assert.strictEqual(stats.held, 1);
      assert.strictEqual(stats.summariesSent, 0, 'window still full');
      assert.strictEqual(sent.length, 3);
      assert.strictEqual(await statuses(dev), 'held:3 sent:4');
    });

    await b('window over: one summary for all held detections, then nothing more', async () => {
      await c.query(`UPDATE place_notifications SET pushed_at = NOW() - interval '7 hours' WHERE install_id = $1 AND push_id IS NOT NULL`, [dev]);
      const stats = await run();
      assert.strictEqual(stats.summariesSent, 1);
      assert.strictEqual(sent.length, 4);
      const m = sent[3];
      assert.deepStrictEqual(m.data, { type: 'place_heat_summary', count: '3' });
      assert.match(m.title, /Yerlerinizin yakınında 3 yeni tespit/);
      assert.strictEqual(m.tag, 'places-summary');
      assert.strictEqual(await statuses(dev), 'sent:4 summarized:3');
      const again = await run();
      assert.strictEqual(again.summariesSent, 0);
      assert.strictEqual(sent.length, 4);
    });

    await b('the summary used a slot: two more pushes, then holding again', async () => {
      await incident(2.5, 'high', 0);
      await run();
      await incident(3.5, 'high', 0);
      await run();
      assert.strictEqual(sent.length, 6);
      await incident(4.5, 'high', 0);
      const stats = await run();
      assert.strictEqual(stats.held, 1);
      assert.strictEqual(sent.length, 6);
    });

    await b('a transient send failure is held for the summary, not lost', async () => {
      await c.query(`UPDATE place_notifications SET status = 'summarized', push_id = gen_random_uuid(), pushed_at = NOW() - interval '7 hours' WHERE install_id = $1 AND status = 'held'`, [dev]);
      await c.query(`UPDATE place_notifications SET pushed_at = NOW() - interval '7 hours' WHERE install_id = $1 AND push_id IS NOT NULL`, [dev]);
      outcome.set(tok1, { success: false, deadToken: false });
      await incident(5.5, 'high', 0);
      const stats = await run();
      assert.strictEqual(stats.failed, 1);
      assert.match(await statuses(dev), /held:1/);
      outcome.delete(tok1);
      const retry = await run();
      assert.strictEqual(retry.summariesSent, 1);
      assert.deepStrictEqual(sent[sent.length - 1].data, { type: 'place_heat_summary', count: '1' });
    });

    await b('a dead token makes the detections undeliverable and clears the token', async () => {
      outcome.set(tok1, { success: false, deadToken: true });
      await incident(6.5, 'high', 0);
      const stats = await run();
      assert.strictEqual(stats.deadTokens, 1);
      const d = await c.query(`SELECT fcm_token, token_invalid_at IS NOT NULL AS dead FROM place_devices WHERE install_id = $1`, [dev]);
      assert.deepStrictEqual(d.rows[0], { fcm_token: null, dead: true });
      assert.match(await statuses(dev), /undeliverable:1/);
      outcome.delete(tok1);
      const before = sent.length;
      await incident(7, 'high', 0);
      const after = await run();
      assert.strictEqual(after.undeliverable, 1, 'no token: recorded, never sent');
      assert.strictEqual(sent.length, before, 'nothing sent without a token');
    });

    await b('a device with notifications off records and sends nothing', async () => {
      await c.query(`UPDATE place_devices SET fcm_token = $2, token_invalid_at = NULL WHERE install_id = $1`, [dev, tok1]);
      await c.query(
        `INSERT INTO fcm_tokens (token, device_name, device_type, is_active) VALUES ($1, 'test', 'android', false)`,
        [tok1]
      );
      await incident(2, 'high', 0);
      const stats = await run();
      assert.strictEqual(stats.newPairs, 0);
      assert.strictEqual(stats.pushesSent, 0);
      await c.query('DELETE FROM fcm_tokens WHERE token = $1', [tok1]);
    });

    await b('a place with alerts off records nothing', async () => {
      await c.query(`UPDATE tracked_places SET notify_heat = false WHERE id = $1`, [placeA]);
      await incident(2, 'high', 0);
      const stats = await run();
      assert.strictEqual(stats.newPairs, 0);
    });

    await b('deleting the device deletes its places and alert records', async () => {
      await c.query('DELETE FROM place_devices WHERE install_id = $1', [dev]);
      const r = await c.query(
        `SELECT (SELECT count(*) FROM tracked_places WHERE install_id = $1)::int AS places,
                (SELECT count(*) FROM place_notifications WHERE install_id = $1)::int AS alerts`, [dev]);
      assert.deepStrictEqual(r.rows[0], { places: 0, alerts: 0 });
    });

    await b('the other device was never alerted (nothing near Antalya)', async () => {
      assert.ok(sent.every((m) => m.token === tok1));
    });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  if (failures > 0) { console.log(`\n${failures} failure(s)`); process.exit(1); }
  console.log('\nall passed (rolled back)');
})().catch((e) => { console.error(e); process.exit(1); });
