/**
 * Unit test for the fixed-heat-source rule (services/heatSource.ts).
 *
 *   npm run test:heat-source
 *
 * Every case below is a REAL incident from GET /api/incidents on
 * 2026-09-24 (id, province, distinct_days_seen, frp_mean, max_frp_mw),
 * hand-labelled by what sits at the coordinates: the Ereğli and Aliağa
 * steelworks, the Aliağa/İzmit refineries, Soma and Karabük plants, SE
 * gas flares — against the late-August Osmaniye fire complex and the
 * Mardin fire. The rule must label every source and no fire.
 *
 * The SQL form of the rule is checked against the pure form by textual
 * equivalence of the thresholds, since there is no database here.
 */
import assert from 'node:assert';
import {
  HEAT_SOURCE_CLASS,
  HEAT_SOURCE_MAX_MEAN_FRP_MW,
  HEAT_SOURCE_MAX_PEAK_FRP_MW,
  HEAT_SOURCE_MIN_DISTINCT_DAYS,
  classifyHeatSource,
  heatSourceReasonSql,
  heatSourceSqlCondition,
} from '../src/services/heatSource';

interface Case {
  id: number;
  where: string;
  days: number;
  mean: number | null;
  peak: number | null;
  expect: 'source' | 'fire';
}

const CASES: Case[] = [
  // ---- fixed heat sources, 50 days of history ----------------------------
  { id: 67, where: 'Zonguldak — Ereğli steelworks', days: 50, mean: 2.3, peak: 11.36, expect: 'source' },
  { id: 37, where: 'İzmir — Aliağa steel/refinery', days: 51, mean: 2.0, peak: 14.14, expect: 'source' },
  { id: 10, where: 'Osmaniye — industrial zone', days: 50, mean: 3.7, peak: 14.27, expect: 'source' },
  { id: 63, where: 'İstanbul — industrial', days: 51, mean: 1.6, peak: 5.13, expect: 'source' },
  { id: 135, where: 'Karaman — plant', days: 51, mean: 1.9, peak: 4.45, expect: 'source' },
  { id: 22, where: 'Gaziantep — industrial zone', days: 51, mean: 1.5, peak: 6.37, expect: 'source' },
  { id: 34, where: 'İzmir — second site', days: 50, mean: 1.7, peak: 3.68, expect: 'source' },
  { id: 137, where: 'Kahramanmaraş — plant', days: 50, mean: 1.3, peak: 3.3, expect: 'source' },
  { id: 574, where: 'İçel (Mersin) — refinery', days: 44, mean: 1.9, peak: 10.19, expect: 'source' },
  { id: 2442, where: 'Tunceli — 22 days at 2 MW', days: 22, mean: 1.9, peak: 8.32, expect: 'source' },
  { id: 2943, where: 'Mardin — flare', days: 21, mean: 1.4, peak: 2.53, expect: 'source' },
  { id: 4394, where: 'Kilis — flare', days: 10, mean: 0.9, peak: 1.31, expect: 'source' },
  { id: 5216, where: 'Manisa — Soma power plant', days: 9, mean: 1.1, peak: 2.59, expect: 'source' },
  { id: 5217, where: 'Manisa — Soma, second stack', days: 9, mean: 1.0, peak: 2.13, expect: 'source' },
  { id: 4956, where: 'Malatya', days: 9, mean: 1.0, peak: 1.7, expect: 'source' },
  { id: 4952, where: 'Bayburt', days: 8, mean: 1.0, peak: 1.83, expect: 'source' },
  { id: 5390, where: 'Karabük — KARDEMİR steelworks', days: 7, mean: 1.6, peak: 4.31, expect: 'source' },
  { id: 5416, where: 'Antalya — 7 days at 1.2 MW', days: 7, mean: 1.2, peak: 1.97, expect: 'source' },
  { id: 5218, where: 'Balıkesir', days: 7, mean: 0.8, peak: 1.08, expect: 'source' },
  { id: 5319, where: 'Denizli', days: 7, mean: 1.4, peak: 2.1, expect: 'source' },

  // ---- real multi-day fires: same duration band, ten times the power ------
  { id: 2518, where: 'Osmaniye fire complex', days: 23, mean: 12.0, peak: 83.21, expect: 'fire' },
  { id: 2754, where: 'Osmaniye fire complex', days: 21, mean: 9.8, peak: 79.08, expect: 'fire' },
  { id: 2469, where: 'Osmaniye fire complex', days: 20, mean: 10.9, peak: 140.22, expect: 'fire' },
  { id: 2553, where: 'Osmaniye fire complex', days: 19, mean: 11.8, peak: 107.29, expect: 'fire' },
  { id: 2669, where: 'Osmaniye fire complex', days: 18, mean: 8.8, peak: 32.6, expect: 'fire' },
  { id: 3124, where: 'Osmaniye fire complex', days: 14, mean: 13.4, peak: 63.24, expect: 'fire' },
  { id: 4159, where: 'Mardin fire', days: 9, mean: 7.5, peak: 56.43, expect: 'fire' },

  // ---- young or short-lived: never classified, whatever the power ---------
  { id: 5947, where: 'Şırnak — 1-day fire', days: 2, mean: 12.0, peak: 69.24, expect: 'fire' },
  { id: 5532, where: 'Diyarbakır — 5 days', days: 5, mean: 3.2, peak: 19.05, expect: 'fire' },
  { id: 5324, where: 'Kocaeli — 6 days weak (one day short)', days: 6, mean: 1.6, peak: 2.71, expect: 'fire' },
  { id: 0, where: 'fresh single pixel, no mean yet', days: 1, mean: null, peak: 3, expect: 'fire' },
  { id: 0, where: 'nulls everywhere', days: 0, mean: null, peak: null, expect: 'fire' },
];

let failures = 0;
console.log('--- rule ---');
for (const c of CASES) {
  const verdict = classifyHeatSource({ distinctDaysSeen: c.days, frpMean: c.mean, maxFrpMw: c.peak });
  const got = verdict.heatSourceClass === HEAT_SOURCE_CLASS ? 'source' : 'fire';
  const ok = got === c.expect;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  #${String(c.id).padStart(4)} ${c.where.padEnd(40)} ` +
      `days=${String(c.days).padStart(2)} mean=${String(c.mean).padStart(5)} peak=${String(c.peak).padStart(6)} → ${got}`
  );
}

console.log('--- boundaries ---');
const b = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};
b('exactly at the day threshold counts', () =>
  assert.strictEqual(classifyHeatSource({ distinctDaysSeen: HEAT_SOURCE_MIN_DISTINCT_DAYS, frpMean: 1, maxFrpMw: 1 }).heatSourceClass, HEAT_SOURCE_CLASS));
b('one day short does not', () =>
  assert.strictEqual(classifyHeatSource({ distinctDaysSeen: HEAT_SOURCE_MIN_DISTINCT_DAYS - 1, frpMean: 1, maxFrpMw: 1 }).heatSourceClass, null));
b('mean at the limit is not below it', () =>
  assert.strictEqual(classifyHeatSource({ distinctDaysSeen: 30, frpMean: HEAT_SOURCE_MAX_MEAN_FRP_MW, maxFrpMw: 1 }).heatSourceClass, null));
b('peak at the limit is not below it', () =>
  assert.strictEqual(classifyHeatSource({ distinctDaysSeen: 30, frpMean: 1, maxFrpMw: HEAT_SOURCE_MAX_PEAK_FRP_MW }).heatSourceClass, null));
b('a null mean can never classify', () =>
  assert.strictEqual(classifyHeatSource({ distinctDaysSeen: 30, frpMean: null, maxFrpMw: 1 }).heatSourceClass, null));
b('reason names all three thresholds', () => {
  const r = classifyHeatSource({ distinctDaysSeen: 50, frpMean: 2.3, maxFrpMw: 11.36 }).reason!;
  assert.match(r, /50 distinct days/); assert.match(r, /2\.3 MW/); assert.match(r, /11\.4 MW/);
});
b('SQL condition carries the same three numbers', () => {
  const sql = heatSourceSqlCondition('fi');
  assert.match(sql, new RegExp(`fi\\.distinct_days_seen >= ${HEAT_SOURCE_MIN_DISTINCT_DAYS}\\b`));
  assert.match(sql, new RegExp(`fi\\.frp_mean < ${HEAT_SOURCE_MAX_MEAN_FRP_MW}\\b`));
  assert.match(sql, new RegExp(`COALESCE\\(fi\\.max_frp_mw, 0\\) < ${HEAT_SOURCE_MAX_PEAK_FRP_MW}\\b`));
  assert.match(sql, /fi\.frp_mean IS NOT NULL/);
});
b('SQL reason quotes the same thresholds', () => {
  const sql = heatSourceReasonSql('fi');
  assert.match(sql, new RegExp(`≥${HEAT_SOURCE_MIN_DISTINCT_DAYS}`));
  assert.match(sql, new RegExp(`<${HEAT_SOURCE_MAX_MEAN_FRP_MW}`));
  assert.match(sql, new RegExp(`<${HEAT_SOURCE_MAX_PEAK_FRP_MW}`));
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
