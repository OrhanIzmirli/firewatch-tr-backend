/**
 * Unit test for nearby_fire_count (services/nearbyFireCount.ts).
 *
 *   npm run test:nearby-fire-count
 *
 * No database: checks the staleness rule, the null-vs-zero semantics the
 * app contract asks for, the risk job's region names, and the shape of the
 * count SQL.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NEARBY_FIRE_MAX_STALENESS_HOURS,
  attachNearbyFireCounts,
  isPipelineFresh,
  nearbyFireCountSql,
} from '../src/services/nearbyFireCount';
import { RegionKey } from '../src/utils/regions';
import { regionFireStatsSql } from '../src/services/nearbyFireCount';

let failures = 0;
const b = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

const now = new Date('2026-11-06T18:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

b('staleness threshold is 6 hours', () => assert.strictEqual(NEARBY_FIRE_MAX_STALENESS_HOURS, 6));
b('fresh when both jobs ran within 6 h', () =>
  assert.ok(isPipelineFresh({ ingest: hoursAgo(1), cluster: hoursAgo(5.9) }, now)));
b('exactly 6 h old still counts as fresh', () =>
  assert.ok(isPipelineFresh({ ingest: hoursAgo(6), cluster: hoursAgo(6) }, now)));
b('stale when ingest is older than 6 h', () =>
  assert.ok(!isPipelineFresh({ ingest: hoursAgo(6.01), cluster: hoursAgo(1) }, now)));
b('stale when cluster is older than 6 h', () =>
  assert.ok(!isPipelineFresh({ ingest: hoursAgo(1), cluster: hoursAgo(11) }, now)));
b('stale when a job never succeeded', () => {
  assert.ok(!isPipelineFresh({ ingest: hoursAgo(1) }, now));
  assert.ok(!isPipelineFresh({ ingest: hoursAgo(1), cluster: null }, now));
  assert.ok(!isPipelineFresh({}, now));
});
b('a run stamped in the future is not trusted', () =>
  assert.ok(!isPipelineFresh({ ingest: new Date(now.getTime() + 60_000), cluster: hoursAgo(1) }, now)));

// The region names the risk job writes to risk_data.region.
const riskJob = readFileSync(join(__dirname, '../src/jobs/riskCalculatorJob.ts'), 'utf8');
const regionsBlock = riskJob.slice(riskJob.indexOf('const REGIONS'), riskJob.indexOf('];', riskJob.indexOf('const REGIONS')));
const riskRegionNames = [...regionsBlock.matchAll(/name: '([^']+)'/g)].map((m) => m[1]);

b('risk job has 7 regions', () => assert.strictEqual(riskRegionNames.length, 7));

b('risk fire stats come from the same incident rows as nearby_fire_count', () => {
  const sql = regionFireStatsSql();
  assert.match(sql, /FROM fire_incidents i/);
  assert.match(sql, /i\.last_detected_at > now\(\) - make_interval\(hours => \$1\)/);
  assert.match(sql, /distinct_days_seen >= 7/, 'fixed heat sources must be excluded');
  assert.match(sql, /d\.confidence_tier = 'high'/);
  assert.match(sql, /i\.region_key IS NOT NULL/);
});
b('risk job reads the database count and no longer calls FIRMS', () => {
  assert.match(riskJob, /loadRegionFireStats\(pool\)/);
  assert.ok(!/firms\.modaps|NASA_API_KEY/.test(riskJob));
  assert.match(riskJob, /fireStatsByRegion === null/, 'a stale pipeline must skip the run, not score zero fires');
});

b('every risk region gets a count; regions without fires get 0, not null', () => {
  const counts = new Map<RegionKey, number>([['ege', 5], ['marmara', 2]]);
  const out = attachNearbyFireCounts(riskRegionNames.map((region) => ({ region })), counts);
  for (const row of out) assert.strictEqual(typeof row.nearby_fire_count, 'number', `${row.region} got ${row.nearby_fire_count}`);
  assert.strictEqual(out.find((r) => r.region === 'Ege')!.nearby_fire_count, 5);
  assert.strictEqual(out.find((r) => r.region === 'Marmara')!.nearby_fire_count, 2);
  assert.strictEqual(out.find((r) => r.region === 'Ic Anadolu')!.nearby_fire_count, 0);
  assert.strictEqual(out.find((r) => r.region === 'Guneydogu Anadolu')!.nearby_fire_count, 0);
});
b('stale pipeline gives null for every region, never 0', () => {
  const out = attachNearbyFireCounts(riskRegionNames.map((region) => ({ region })), null);
  for (const row of out) assert.strictEqual(row.nearby_fire_count, null);
});
b('unknown region name gives null', () => {
  const [row] = attachNearbyFireCounts([{ region: 'Atlantis' }], new Map());
  assert.strictEqual(row.nearby_fire_count, null);
});
b('other row fields are kept and the input is not mutated', () => {
  const input = { region: 'Ege', general_risk_score: 62 };
  const [row] = attachNearbyFireCounts([input], new Map([['ege', 1]]));
  assert.strictEqual(row.general_risk_score, 62);
  assert.ok(!('nearby_fire_count' in input));
});

b('count SQL: 24 h window as a parameter, heat sources excluded null-safely', () => {
  const sql = nearbyFireCountSql();
  assert.match(sql, /last_detected_at > now\(\) - make_interval\(hours => \$1\)/);
  // NOT (NULL) would drop incidents with no FRP stats; COALESCE keeps them.
  assert.match(sql, /NOT COALESCE\(\(i\.distinct_days_seen >= 7 AND/);
  assert.match(sql, /GROUP BY i\.region_key/);
  assert.ok(!/heat_source_class/.test(sql), 'must not depend on migration 011');
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
