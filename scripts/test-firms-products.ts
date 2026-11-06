/**
 * Unit test for the FIRMS product order (services/firmsProducts.ts).
 *
 *   npm run test:firms-products
 *
 * Suomi NPP stopped delivering on 2026-11-02. The first-answer-wins lookups
 * (risk fire stats, /api/thermal) must ask NOAA-20/21 first and S-NPP last,
 * and both callers must use these lists rather than their own.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FirmsAttempt, RISK_FIRE_STATS_ATTEMPTS, THERMAL_ATTEMPTS } from '../src/services/firmsProducts';

let failures = 0;
const b = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

const KNOWN = new Set(['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT', 'MODIS_NRT']);

function checkOrder(name: string, attempts: readonly FirmsAttempt[]) {
  b(`${name}: NOAA-20 first, then NOAA-21`, () => {
    assert.strictEqual(attempts[0].product, 'VIIRS_NOAA20_NRT');
    assert.strictEqual(attempts[1].product, 'VIIRS_NOAA21_NRT');
  });
  b(`${name}: S-NPP only as the very last attempt`, () => {
    const snpp = attempts.map((a, i) => (a.product === 'VIIRS_SNPP_NRT' ? i : -1)).filter((i) => i >= 0);
    assert.deepStrictEqual(snpp, [attempts.length - 1]);
  });
  b(`${name}: MODIS comes after both NOAA satellites`, () => {
    const firstModis = attempts.findIndex((a) => a.product === 'MODIS_NRT');
    assert.ok(firstModis > 1, `MODIS at ${firstModis}`);
  });
  b(`${name}: only known products, sane windows, no duplicates`, () => {
    const seen = new Set<string>();
    for (const a of attempts) {
      assert.ok(KNOWN.has(a.product), a.product);
      assert.ok(Number.isInteger(a.days) && a.days >= 1 && a.days <= 10, `${a.product}/${a.days}`);
      const key = `${a.product}/${a.days}`;
      assert.ok(!seen.has(key), `duplicate ${key}`);
      seen.add(key);
    }
  });
}

checkOrder('risk fire stats', RISK_FIRE_STATS_ATTEMPTS);
checkOrder('thermal', THERMAL_ATTEMPTS);

b('thermal keeps two days as its primary window', () => assert.strictEqual(THERMAL_ATTEMPTS[0].days, 2));

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
b('riskCalculatorJob uses the shared list and names no product itself', () => {
  const job = src('src/jobs/riskCalculatorJob.ts');
  assert.match(job, /for \(const attempt of RISK_FIRE_STATS_ATTEMPTS\)/);
  assert.ok(!/'VIIRS_SNPP_NRT'|'MODIS_NRT'/.test(job));
});
b('thermal route uses the shared list and names no product itself', () => {
  const route = src('src/routes/thermal.ts');
  assert.match(route, /const attempts = THERMAL_ATTEMPTS;/);
  assert.ok(!/'VIIRS_SNPP_NRT'|'MODIS_NRT'/.test(route));
});
b('ingest still fetches all four products (union, order irrelevant)', () => {
  const ingest = src('src/jobs/fireIngestJob.ts');
  for (const p of KNOWN) assert.ok(ingest.includes(`product: '${p}'`), p);
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
