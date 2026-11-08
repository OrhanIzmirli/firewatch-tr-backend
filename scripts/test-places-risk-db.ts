/**
 * Runs migration 016 and the daily fire-danger pass against a real PostGIS
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

const migration = readFileSync(join(__dirname, '..', 'database', 'migrations', '016_place_risk_alerts.sql'), 'utf8')
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
    await c.query(migration);
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
      const stats = await job.runPlaceRiskAlerts(c, send as any, async () => 3, noon, { forgetFcmTokens: false });
      assert.strictEqual(stats.pushesSent, 1);
      assert.deepStrictEqual(await state(), { last_class: 3, checked: '2026-07-02', notified: '2026-07-02' });
    });
    await b('same day: not due again', async () => {
      const stats = await job.runPlaceRiskAlerts(c, send as any, async () => 5, noon, { forgetFcmTokens: false });
      assert.strictEqual(stats.checked, 0);
      assert.strictEqual(sent.length, 1);
    });
    await b('next day, still High: checked, silent, notified date kept', async () => {
      await job.runPlaceRiskAlerts(c, send as any, async () => 3, new Date('2026-07-03T09:00:00Z'), { forgetFcmTokens: false });
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(await state(), { last_class: 3, checked: '2026-07-03', notified: '2026-07-02' });
    });
    await b('switch off: not checked', async () => {
      await c.query('UPDATE tracked_places SET notify_risk = false WHERE id = $1', [placeId]);
      const stats = await job.runPlaceRiskAlerts(c, send as any, async () => 5, new Date('2026-07-04T09:00:00Z'), { forgetFcmTokens: false });
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
