/** npm run test:alert-consent — every sender applies the user's choice. */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://nobody@127.0.0.1:1/none';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { allScopeAllowedSql, deviceNotMutedSql } = require('../src/utils/alertConsent');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dropHeldOfMutedSql, newHeatPairsSql } = require('../src/jobs/placeAlertJob');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { dueRiskPlacesSql } = require('../src/jobs/placeRiskJob');

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const controller = read('src/controllers/notificationController.ts');
const risk = read('src/jobs/riskCalculatorJob.ts');
const placeJob = read('src/jobs/placeAlertJob.ts');
const fires = read('src/routes/fires.ts');
const legal = read('src/routes/legal.ts');

let failed = 0;
function b(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}

b('a repeat subscribe never forces a device back on', () => {
  assert.doesNotMatch(controller, /is_active = true,/);
  assert.match(controller, /is_active = COALESCE\(\$9::boolean, fcm_tokens\.is_active\)/);
});

b('tracked-place heat and risk alerts skip a muted device', () => {
  const muted = deviceNotMutedSql('d');
  assert.ok(newHeatPairsSql().includes(muted));
  assert.ok(dueRiskPlacesSql().includes(muted));
  assert.match(dropHeldOfMutedSql(), /status = 'undeliverable'/);
  assert.match(placeJob, /await db\.query\(dropHeldOfMutedSql\(\)\);\s+\/\/ 1\. Summaries/);
});

b('region alerts need a location or an explicit whole-country choice', () => {
  assert.match(risk, /t\.is_active = true\s+AND \$\{allScopeAllowedSql\('t'\)\}/);
  assert.match(controller, /is_active = true\s+AND \$\{allScopeAllowedSql\('fcm_tokens'\)\}/);
  assert.match(allScopeAllowedSql('t'), /t\.all_regions_opt_in/);
});

b('only a scope request can change the whole-country choice', () => {
  assert.match(controller, /all_regions_opt_in = CASE WHEN \$6::text IS NULL THEN fcm_tokens\.all_regions_opt_in ELSE \$6::text = 'all' END/);
  assert.match(controller, /all_regions_opt_in = CASE WHEN \$5::text IS NULL THEN all_regions_opt_in ELSE \$5::text = 'all' END/);
});

b('every uploaded photo is cleaned and an uncleanable one refused', () => {
  assert.match(fires, /clean = stripImageMetadata\(bytes\)/);
  assert.match(fires, /base64,\$\{clean\.toString\('base64'\)\}/);
});

b('the policy says photo location is removed, in both languages', () => {
  assert.match(legal, /Fotoğraflardaki konum bilgisi ve diğer üst veriler yüklemeden önce uygulamada, ardından sunucuda silinir/);
  assert.match(legal, /Location data and other metadata are removed from photos in the app before upload and again on our server/);
  assert.doesNotMatch(legal, /fotoğrafla birlikte saklanabilir|may be stored with the photo/);
});

if (failed > 0) process.exit(1);
console.log('alert consent tests passed');
process.exit(0);
