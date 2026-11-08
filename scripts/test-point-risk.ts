/**
 * The FireWatch risk score: one formula for regions, points and alerts.
 *
 *   npm run test:point-risk
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import express from 'express';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nobody@127.0.0.1:1/none';
/* eslint-disable @typescript-eslint/no-var-requires */
const score = require('../src/services/riskScore') as typeof import('../src/services/riskScore');
const point = require('../src/services/pointRisk') as typeof import('../src/services/pointRisk');
const route = require('../src/routes/pointRisk') as typeof import('../src/routes/pointRisk');
const status = require('../src/services/detectionStatus') as typeof import('../src/services/detectionStatus');

let failures = 0;
async function b(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
}
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const w = (temperature: number, humidity: number, windSpeed: number) =>
  ({ temperature, humidity, windSpeed, windDirection: 'K' }) as any;

function deps(over: Partial<import('../src/services/pointRisk').PointRiskDeps> = {}) {
  const store = new Map<string, unknown>();
  const calls = { weather: [] as number[][] };
  return {
    store,
    calls,
    d: {
      weather: async (lat: number, lng: number) => { calls.weather.push([lat, lng]); return w(36, 25, 30); },
      nearby: async () => 2,
      province: async () => ({ name: 'İzmir', region: 'Ege' }),
      cache: {
        get: async <T>(k: string) => (store.get(k) as T) ?? null,
        set: async <T>(k: string, v: T) => { store.set(k, v); return true; },
      },
      now: () => new Date('2026-07-02T09:00:00Z'),
      ...over,
    } as import('../src/services/pointRisk').PointRiskDeps,
  };
}

(async () => {
  await b('levels: 25 / 50 / 75, four of them', () => {
    const f = score.riskLevelForScore;
    assert.deepStrictEqual([0, 24, 25, 49, 50, 74, 75, 100].map(f),
      ['Low', 'Low', 'Medium', 'Medium', 'High', 'High', 'Critical', 'Critical']);
    assert.deepStrictEqual(['Low', 'Medium', 'High', 'Critical'].map(score.riskLevelIndex), [0, 1, 2, 3]);
  });
  await b('score: the bucket values', () => {
    assert.strictEqual(score.calculateRisk(w(10, 80, 5), 0).score, 0);
    assert.strictEqual(score.calculateRisk(w(25, 50, 10), 1).score, 7 + 6 + 5 + 5);
    assert.strictEqual(score.calculateRisk(w(30, 40, 20), 2).score, 14 + 13 + 11 + 10);
    assert.strictEqual(score.calculateRisk(w(35, 30, 35), 5).score, 22 + 20 + 18 + 15);
    assert.strictEqual(score.calculateRisk(w(39, 29, 0), 0).score, 22 + 20 + 10, 'hot and dry bonus');
    assert.strictEqual(score.calculateRisk(w(41, 19, 60), 10).score, 100, 'capped');
  });
  await b('there is one formula: nobody else has the thresholds', () => {
    assert.match(src('src/jobs/riskCalculatorJob.ts'), /calculateRisk\(weather, fireStats\.incidents\)/);
    assert.ok(!/private calculateRisk/.test(src('src/jobs/riskCalculatorJob.ts')));
    assert.match(src('src/services/pointRisk.ts'), /import \{ calculateRisk \} from '\.\/riskScore'/);
    assert.ok(!/temperature >= 40/.test(src('src/services/pointRisk.ts')));
    assert.ok(!/fwi/i.test(src('src/jobs/placeRiskJob.ts')), 'the alert does not use FWI');
  });
  await b('point: same score as the formula, with the row keys the app reads', async () => {
    const { d } = deps();
    const r = await point.computePointRisk(38.3, 26.77, d);
    const expected = score.calculateRisk(w(36, 25, 30), 2);
    assert.strictEqual(r.general_risk_score, expected.score);
    assert.strictEqual(r.risk_level, expected.level);
    assert.strictEqual(r.dryness_index, expected.drynessIndex);
    assert.strictEqual(r.vegetation_density, expected.vegetationPressure);
    assert.strictEqual(r.nearby_fire_count, 2);
    assert.strictEqual(r.nearby_radius_km, 50);
    assert.strictEqual(r.city, 'İzmir');
  });
  await b('privacy: only the rounded point goes out and is returned', async () => {
    const { d, calls, store } = deps();
    const r = await point.computePointRisk(38.3456, 26.7812, d);
    assert.deepStrictEqual(calls.weather[0], [38.3, 26.8]);
    assert.strictEqual(r.latitude, 38.3);
    assert.strictEqual(r.longitude, 26.8);
    assert.deepStrictEqual([...store.keys()], ['risk:point:v1:38.3:26.8']);
  });
  await b('neighbours in one grid cell share one reading', async () => {
    const { d, calls } = deps();
    await point.computePointRisk(38.31, 26.77, d);
    await point.computePointRisk(38.29, 26.81, d);
    assert.strictEqual(calls.weather.length, 1);
  });
  await b('stale pipeline: count is unknown, not zero', async () => {
    const { d } = deps({ nearby: async () => null });
    const r = await point.computePointRisk(38.3, 26.77, d);
    assert.strictEqual(r.nearby_fire_count, null);
    assert.strictEqual(r.general_risk_score, score.calculateRisk(w(36, 25, 30), 0).score);
  });
  await b('no province is not an error; no weather is', async () => {
    const a = deps({ province: async () => { throw new Error('db'); } });
    assert.strictEqual((await point.computePointRisk(38.3, 26.77, a.d)).city, null);
    const c = deps({ weather: async () => { throw new Error('net'); } });
    await assert.rejects(point.computePointRisk(38.3, 26.77, c.d), /net/);
    assert.strictEqual(c.store.size, 0, 'a failure is not cached');
  });

  const fakeStatusDb = (jobAgeHours: number | null, n: number, latest: string | null, city: string | null) => {
    const now = new Date('2026-07-02T09:00:00Z');
    const lastOk = jobAgeHours === null ? null : new Date(now.getTime() - jobAgeHours * 3_600_000);
    return { query: async (sql: string) => {
      if (/job_runs/.test(sql)) return { rows: [{ job: 'ingest', db_now: now, last_ok: lastOk }, { job: 'cluster', db_now: now, last_ok: lastOk }] };
      if (/count\(\*\)/.test(sql)) return { rows: [{ n, latest }] };
      return { rows: [{ city }] };
    } } as any;
  };
  await b('status: fresh and quiet is a real zero', async () => {
    const r = await status.loadDetectionStatus(fakeStatusDb(1, 0, '2026-06-29T10:00:00Z', 'Muğla'));
    assert.strictEqual(r.pipeline_fresh, true);
    assert.strictEqual(r.strong_detections_24h, 0);
    assert.deepStrictEqual(r.latest_detection, { detected_at: '2026-06-29T10:00:00.000Z', city: 'Muğla' });
    assert.strictEqual(r.last_update_at, '2026-07-02T08:00:00.000Z');
  });
  await b('status: a stale pipeline never says zero', async () => {
    const r = await status.loadDetectionStatus(fakeStatusDb(9, 0, null, null));
    assert.strictEqual(r.pipeline_fresh, false);
    assert.strictEqual(r.strong_detections_24h, null);
    assert.strictEqual(r.latest_detection, null);
  });
  await b('status: never-run jobs are unknown, with no time to show', async () => {
    const r = await status.loadDetectionStatus(fakeStatusDb(null, 0, null, null));
    assert.strictEqual(r.pipeline_fresh, false);
    assert.strictEqual(r.last_update_at, null);
  });

  const app = express();
  app.use(express.json());
  let current = deps().d;
  app.use('/api/risk', route.pointRiskRouter(() => current));
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const post = async (body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/risk/point`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as any };
  };
  await b('route: a point in Turkey', async () => {
    const r = await post({ latitude: 38.3, longitude: 26.77 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.data.nearby_radius_km, 50);
  });
  await b('route: bad input and outside Turkey', async () => {
    assert.strictEqual((await post({ latitude: 'x', longitude: 26 })).status, 400);
    assert.strictEqual((await post({ longitude: 26 })).status, 400);
    const out = await post({ latitude: 48.8, longitude: 2.3 });
    assert.strictEqual(out.status, 422);
    assert.strictEqual(out.json.code, 'outside_turkey');
  });
  await b('route: no weather is 503, not a made-up score', async () => {
    current = deps({ weather: async () => { throw new Error('net'); } }).d;
    const r = await post({ latitude: 38.3, longitude: 26.77 });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.json.code, 'risk_unavailable');
  });
  server.close();
  server.closeAllConnections();

  await b('policy matches: point risk in both languages, no server-side FWI', () => {
    const legal = src('src/routes/legal.ts');
    assert.match(legal, /Noktasal risk:/);
    assert.match(legal, /Risk at a point:/);
    assert.ok(!/yakınınızdaki risk telefonunuzda/.test(legal));
    assert.ok(!/the risk near you are calculated on your phone/.test(legal));
    assert.ok(!/Günlük tehlike bildirimi/.test(legal));
  });

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
