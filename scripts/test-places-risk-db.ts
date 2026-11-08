/**
 * Runs migrations 016 and 017 and the place risk pass against a real PostGIS
 * database, inside one transaction that is always rolled back.
 *
 *   TEST_DATABASE_URL=postgres://... npm run test:places-risk-db
 *
 * Use a throwaway database or a Neon branch that already has migration 014.
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
process.env.DATABASE_URL = 'postgres://nobody@127.0.0.1:1/none';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const job = require('../src/jobs/placeRiskJob') as typeof import('../src/jobs/placeRiskJob');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const point = require('../src/services/pointRisk') as typeof import('../src/services/pointRisk');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const status = require('../src/services/detectionStatus') as typeof import('../src/services/detectionStatus');

const migrationSql = (file: string) => readFileSync(join(__dirname, '..', 'database', 'migrations', file), 'utf8')
  .split('\n')
  .filter((l) => !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
  .join('\n');

let failures = 0;
async function b(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
}

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query('BEGIN');
  try {
    if ((await c.query(`SELECT to_regclass('place_risk_state') AS t`)).rows[0].t === null) {
      await c.query(migrationSql('016_place_risk_alerts.sql'));
    }
    await c.query(migrationSql('017_place_risk_score.sql'));
    // The branch is a copy of real data; this test only counts its own place.
    await c.query('DELETE FROM tracked_places');
    const install = '11111111-1111-4111-8111-111111111111';
    await c.query(`INSERT INTO place_devices (install_id, secret_hash, fcm_token, locale)
                   VALUES ($1, decode(repeat('ab', 32), 'hex'), 'test-token-0123456789012345', 'tr')`, [install]);
    const inserted = await c.query(
      `INSERT INTO tracked_places (install_id, name, latitude, longitude, radius_m)
       VALUES ($1, 'Urla', 38.30, 26.77, 10000) RETURNING id, notify_risk`, [install]);
    const placeId = inserted.rows[0].id;
    const noon = new Date('2026-07-02T09:00:00Z');
    const sent: any[] = [];
    const send = async (m: any[]) => { sent.push(...m); return m.map(() => ({ success: true, deadToken: false })); };
    const state = async () => (await c.query(
      `SELECT last_class, to_char(last_checked_on,'YYYY-MM-DD') AS checked, to_char(last_notified_on,'YYYY-MM-DD') AS notified
         FROM place_risk_state WHERE place_id = $1`, [placeId])).rows[0];

    await b('existing and new places default to the switch being on', async () => {
      assert.strictEqual(inserted.rows[0].notify_risk, true);
    });
    await b('High: one push, state recorded', async () => {
      const stats = await job.runPlaceRiskAlerts(c, send as any, async () => ({ level: 2, score: 58 }), noon, { forgetFcmTokens: false });
      assert.strictEqual(stats.pushesSent, 1);
      assert.deepStrictEqual(await state(), { last_class: 2, checked: '2026-07-02', notified: '2026-07-02' });
    });
    await b('within three hours: not due again', async () => {
      const stats = await job.runPlaceRiskAlerts(c, send as any, async () => ({ level: 3, score: 90 }), new Date('2026-07-02T11:00:00Z'), { forgetFcmTokens: false });
      assert.strictEqual(stats.checked, 0);
      assert.strictEqual(sent.length, 1);
    });
    await b('same day, later and worse: checked, but one push a day', async () => {
      const stats = await job.runPlaceRiskAlerts(c, send as any, async () => ({ level: 3, score: 90 }), new Date('2026-07-02T12:30:00Z'), { forgetFcmTokens: false });
      assert.strictEqual(stats.checked, 1);
      assert.strictEqual(sent.length, 1);
      assert.strictEqual((await state()).last_class, 3);
    });
    await b('next day, still at that level: checked, silent, notified date kept', async () => {
      await job.runPlaceRiskAlerts(c, send as any, async () => ({ level: 3, score: 90 }), new Date('2026-07-03T09:00:00Z'), { forgetFcmTokens: false });
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(await state(), { last_class: 3, checked: '2026-07-03', notified: '2026-07-02' });
    });
    await b('the nearby-incident SQL runs against the real schema', async () => {
      const r = await c.query(point.nearbyIncidentCountSql(), [26.77, 38.3, 24, 50000]);
      assert.strictEqual(typeof r.rows[0].n, 'number');
    });
    await b('the pipeline freshness query runs against the real schema', async () => {
      const errors: unknown[] = [];
      const original = console.error;
      console.error = (...a: unknown[]) => { errors.push(a); };
      try { await point.loadNearbyIncidentCount(c, 38.3, 26.77); } finally { console.error = original; }
      assert.deepStrictEqual(errors, []);
    });
    await b('detection status runs against the real schema', async () => {
      const r = await status.loadDetectionStatus(c);
      assert.strictEqual(typeof r.pipeline_fresh, 'boolean');
      if (r.pipeline_fresh) assert.strictEqual(typeof r.strong_detections_24h, 'number');
      else assert.strictEqual(r.strong_detections_24h, null);
      console.log('      ' + JSON.stringify(r));
    });
    await b('switch off: not checked', async () => {
      await c.query('UPDATE tracked_places SET notify_risk = false WHERE id = $1', [placeId]);
      const stats = await job.runPlaceRiskAlerts(c, send as any, async () => ({ level: 3, score: 90 }), new Date('2026-07-04T09:00:00Z'), { forgetFcmTokens: false });
      assert.strictEqual(stats.checked, 0);
    });
    await b('state goes with the place', async () => {
      await c.query('DELETE FROM tracked_places WHERE id = $1', [placeId]);
      assert.strictEqual(await state(), undefined);
    });
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
