/**
 * Runs the real controller and alert queries against a throwaway Neon branch
 * that already has migration 020. Rows use a test token prefix and are
 * removed at the end.
 *
 *   TEST_DATABASE_URL=postgres://... npm run test:alert-consent-db
 */
import assert from 'node:assert';
import { join } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('TEST_DATABASE_URL not set — skipping.');
  process.exit(0);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ path: join(__dirname, '..', '.env'), quiet: true });
if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).host === new URL(url).host) {
  console.error('Refusing to run: TEST_DATABASE_URL points at the production database.');
  process.exit(1);
}
process.env.DATABASE_URL = url;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pool = require('../src/config/database').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const controller = require('../src/controllers/notificationController').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const riskJob = require('../src/jobs/riskCalculatorJob').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { deviceNotMutedSql } = require('../src/utils/alertConsent');

const PREFIX = 'consent-test-token-0000000000-';
const t = (name: string) => PREFIX + name;

async function call(method: 'subscribeToken' | 'setActiveStatus', body: unknown): Promise<number> {
  let status = 200;
  const res: any = { status(c: number) { status = c; return res; }, json() { return res; }, set() { return res; } };
  await controller[method]({ body }, res);
  return status;
}

const row = async (name: string) =>
  (await pool.query(`SELECT is_active, latitude, longitude, alert_scope, all_regions_opt_in FROM fcm_tokens WHERE token = $1`, [t(name)])).rows[0];
const REGION = { name: 'Ege', display: 'Ege', lat: 38.4, lng: 27.1 };
const near = async () => (await riskJob.getActiveTokensNearRegion(REGION)) as string[];

async function main(): Promise<void> {
  await pool.query(`DELETE FROM fcm_tokens WHERE token LIKE $1`, [PREFIX + '%']);
  try {
    // Off, then the start-up ping an old or new app sends.
    assert.strictEqual(await call('subscribeToken', { token: t('a'), latitude: 38.4, longitude: 27.1 }), 201);
    assert.strictEqual((await row('a')).is_active, true);
    assert.ok((await near()).includes(t('a')), 'a placed device matches by distance');
    assert.strictEqual(await call('setActiveStatus', { token: t('a'), is_active: false }), 200);
    assert.strictEqual(await call('subscribeToken', { token: t('a') }), 201);
    let a = await row('a');
    assert.strictEqual(a.is_active, false, 'the bare ping must not reactivate');
    assert.strictEqual(a.latitude, null);
    assert.ok(!(await near()).includes(t('a')));

    // An explicit on works; a location also counts for older apps.
    assert.strictEqual(await call('subscribeToken', { token: t('a'), is_active: true }), 201);
    assert.strictEqual((await row('a')).is_active, true);
    await call('setActiveStatus', { token: t('a'), is_active: false });
    await call('subscribeToken', { token: t('a'), latitude: 38.4, longitude: 27.1 });
    a = await row('a');
    assert.strictEqual(a.is_active, true);
    assert.ok(a.latitude !== null);

    // is_active:false registers a rotated token off, even with a scope.
    await call('subscribeToken', { token: t('b'), is_active: false, alert_scope: 'all', latitude: 38.4, longitude: 27.1 });
    const b = await row('b');
    assert.strictEqual(b.is_active, false);
    assert.strictEqual(b.latitude, null);

    // Default 'all' without a location gets nothing.
    await call('subscribeToken', { token: t('c') });
    assert.strictEqual((await row('c')).all_regions_opt_in, false);
    assert.ok(!(await near()).includes(t('c')), 'no location and no choice: no region alert');

    // The explicit choice opens it; a later ping keeps it; narrowing clears it.
    await call('setActiveStatus', { token: t('c'), is_active: true, alert_scope: 'all' });
    assert.strictEqual((await row('c')).all_regions_opt_in, true);
    assert.ok((await near()).includes(t('c')));
    await call('subscribeToken', { token: t('c') });
    assert.strictEqual((await row('c')).all_regions_opt_in, true);
    await call('setActiveStatus', { token: t('c'), is_active: true, alert_scope: 'region', region_key: 'ege' });
    const c = await row('c');
    assert.strictEqual(c.all_regions_opt_in, false);
    assert.strictEqual(c.alert_scope, 'region');
    assert.ok((await near()).includes(t('c')), 'a chosen region still reaches a device with no location');

    // The muted condition, as the tracked-place jobs use it.
    const muted = async (name: string) =>
      (await pool.query(`SELECT ${deviceNotMutedSql('d')} AS on FROM (SELECT $1::text AS fcm_token) d`, [name])).rows[0].on;
    assert.strictEqual(await muted(t('b')), false);
    assert.strictEqual(await muted(t('c')), true);
    assert.strictEqual(await muted(t('never-registered')), true);
    console.log('alert consent DB tests passed');
  } finally {
    await pool.query(`DELETE FROM fcm_tokens WHERE token LIKE $1`, [PREFIX + '%']);
    await pool.end();
  }
}

main().catch((e) => {
  console.error('FAILED:', (e as Error).message.replace(/postgres\S+/g, '<redacted>'));
  process.exit(1);
});
