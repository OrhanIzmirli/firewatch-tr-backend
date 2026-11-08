/**
 * Place search (Nominatim rules) and the alert when a place's risk rises.
 *
 *   npm run test:places-search-risk
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nobody@127.0.0.1:1/none';
/* eslint-disable @typescript-eslint/no-var-requires */
const search = require('../src/services/placeSearch') as typeof import('../src/services/placeSearch');
const risk = require('../src/jobs/placeRiskJob') as typeof import('../src/jobs/placeRiskJob');
const places = require('../src/services/trackedPlaces') as typeof import('../src/services/trackedPlaces');

let failures = 0;
async function b(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
}
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

function deps(body: unknown, env: Record<string, string> = {}) {
  const store = new Map<string, unknown>();
  const calls: { url: string; config: any }[] = [];
  return {
    calls,
    store,
    d: {
      http: { get: async (url: string, config: any) => { calls.push({ url, config }); return { data: body }; } },
      cache: {
        get: async <T>(k: string) => (store.get(k) as T) ?? null,
        set: async <T>(k: string, v: T) => { store.set(k, v); return true; },
      },
      wait: async () => undefined,
      now: () => 0,
      env,
    },
  };
}
const raw = [{ lat: '38.30', lon: '26.77', name: 'Zeytinalanı', display_name: 'Zeytinalanı, Urla, İzmir, Ege Bölgesi, 35430, Türkiye' }];

(async () => {
  await b('query: trimmed, 3-120 characters', () => {
    assert.strictEqual(search.parseSearchQuery('  Urla   Zeytinalanı '), 'Urla Zeytinalanı');
    assert.strictEqual(search.parseSearchQuery('ab'), null);
    assert.strictEqual(search.parseSearchQuery('x'.repeat(121)), null);
    assert.strictEqual(search.parseSearchQuery(5), null);
  });
  await b('cache key: same query in any case, and never the text itself', () => {
    assert.strictEqual(search.searchCacheKey('URLA'), search.searchCacheKey('urla'));
    assert.ok(!search.searchCacheKey('Urla Zeytinalanı').includes('Urla'));
  });
  await b('results: short name, label without country or postcode, foreign points dropped', () => {
    const parsed = search.parseNominatim([...raw, { lat: '37.98', lon: '23.72', name: 'Atina', display_name: 'Atina, Yunanistan' }]);
    assert.strictEqual(parsed.length, 1);
    assert.deepStrictEqual(parsed[0], { name: 'Zeytinalanı', label: 'Zeytinalanı, Urla, İzmir, Ege Bölgesi', latitude: 38.3, longitude: 26.77 });
    assert.deepStrictEqual(search.parseNominatim({ error: 'x' }), []);
  });
  await b('request identifies the app and is limited to Turkey', async () => {
    const { d, calls } = deps(raw);
    await search.searchPlaces('Zeytinalanı', d as any, new search.NominatimQueue(d.wait, d.now));
    assert.strictEqual(calls[0].url, 'https://nominatim.openstreetmap.org/search');
    assert.match(calls[0].config.headers['User-Agent'], /firewatch-tr-backend/);
    assert.ok(!/axios/i.test(calls[0].config.headers['User-Agent']));
    assert.strictEqual(calls[0].config.params.countrycodes, 'tr');
  });
  await b('a repeated search is answered from the cache', async () => {
    const { d, calls } = deps(raw);
    const q = new search.NominatimQueue(d.wait, d.now);
    await search.searchPlaces('Urla', d as any, q);
    await search.searchPlaces('urla', d as any, q);
    assert.strictEqual(calls.length, 1);
  });
  await b('an empty answer is cached too', async () => {
    const { d, calls } = deps([]);
    const q = new search.NominatimQueue(d.wait, d.now);
    await search.searchPlaces('olmayan yer', d as any, q);
    await search.searchPlaces('olmayan yer', d as any, q);
    assert.strictEqual(calls.length, 1);
  });
  await b('the service can be switched or turned off without an app update', async () => {
    const off = deps(raw, { NOMINATIM_ENABLED: 'false' });
    await assert.rejects(search.searchPlaces('Urla', off.d as any, new search.NominatimQueue(off.d.wait, off.d.now)), /disabled/);
    assert.strictEqual(off.calls.length, 0);
    const other = deps(raw, { NOMINATIM_BASE_URL: 'https://geo.example.org/' });
    await search.searchPlaces('Urla', other.d as any, new search.NominatimQueue(other.d.wait, other.d.now));
    assert.strictEqual(other.calls[0].url, 'https://geo.example.org/search');
  });
  await b('queue: never two requests within a second', async () => {
    let clock = 0;
    const starts: number[] = [];
    const q = new search.NominatimQueue(async (ms) => { clock += ms; }, () => clock);
    await Promise.all([1, 2, 3].map(() => q.run(async () => { starts.push(clock); })));
    assert.strictEqual(starts.length, 3);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= search.NOMINATIM_MIN_INTERVAL_MS);
  });
  await b('queue: refuses rather than building a backlog', async () => {
    const q = new search.NominatimQueue(() => new Promise(() => undefined), () => 1_000_000);
    const pending: Promise<unknown>[] = [];
    await q.run(async () => undefined).catch(() => undefined);
    for (let i = 0; i < search.NOMINATIM_MAX_QUEUE; i++) pending.push(q.run(async () => undefined));
    await assert.rejects(q.run(async () => undefined), /busy/);
  });
  await b('the query never reaches a log or a URL of ours', () => {
    const s = src('src/services/placeSearch.ts');
    assert.ok(!/console\.\w+\([^)]*query/.test(s));
    assert.match(src('src/routes/places.ts'), /router\.post\('\/search'/);
  });

  await b('patch: only what was sent, position cannot change', () => {
    assert.deepStrictEqual(places.parsePlacePatch({ name: ' Ev ', radius_km: 25 }), { name: 'Ev', radiusM: 25000 });
    assert.deepStrictEqual(places.parsePlacePatch({ notify_risk: false }), { notifyRisk: false });
    assert.deepStrictEqual(places.parsePlacePatch({ latitude: 1 }), 'nothing to update');
    assert.match(String(places.parsePlacePatch({ radius_km: 7 })), /radius_km/);
    assert.match(String(places.parsePlacePatch({ notify_heat: 'yes' })), /boolean/);
  });
  await b('risk switch defaults on and is validated', () => {
    const base = { name: 'Ev', latitude: 38.4, longitude: 27.1, radius_km: 5 };
    assert.strictEqual((places.parsePlaceInput(base) as any).notifyRisk, true);
    assert.strictEqual((places.parsePlaceInput({ ...base, notify_risk: false }) as any).notifyRisk, false);
    assert.match(String(places.parsePlaceInput({ ...base, notify_risk: 1 })), /notify_risk/);
  });
  await b('alert rule: rises to High or above, once a day', () => {
    const f = risk.shouldAlert;
    assert.strictEqual(f(1, 2, null, '2026-07-02'), true);
    assert.strictEqual(f(null, 3, null, '2026-07-02'), true);
    assert.strictEqual(f(2, 3, '2026-07-01', '2026-07-02'), true);
    assert.strictEqual(f(2, 2, '2026-07-01', '2026-07-02'), false, 'staying High does not repeat');
    assert.strictEqual(f(1, 1, null, '2026-07-02'), false);
    assert.strictEqual(f(1, 3, '2026-07-02', '2026-07-02'), false, 'at most once a day');
  });
  await b('alert text says index, not fire', () => {
    const tr = places.buildRiskAlertText('tr', 'Urla', 2, 58, 0);
    assert.match(tr.title, /Urla: yangın riski Yüksek/);
    assert.match(tr.body, /58\/100/);
    assert.match(tr.body, /tespit edilmiş yangın değildir/);
    assert.match(places.buildRiskAlertText('en', 'Urla', 3, 80, 2).title, /fire risk Critical/);
    assert.match(places.buildRiskAlertText('en', 'Urla', 3, 80, 2).body, /\+2 more of your places/);
  });
  await b('Turkish clock whatever the server zone', () => {
    assert.deepStrictEqual(risk.turkeyClock(new Date('2026-07-01T22:30:00Z')), { date: '2026-07-02', hour: 1 });
  });
  function fakeDb(rows: any[]) {
    const saved: any[][] = [];
    return { saved, db: { query: async (sql: string, params?: unknown[]) => {
      if (/place_risk_state \(place_id/.test(sql)) saved.push(params as any[]);
      return { rows: /FROM tracked_places p/.test(sql) ? rows : [], rowCount: 0 };
    } } };
  }
  const row = (id: string, install: string, last: number | null, extra: object = {}) => ({
    place_id: id, install_id: install, place_name: id, latitude: '38.30', longitude: '26.77',
    fcm_token: `tok-${install}-xxxxxxxxxxxxxxxxxxxx`, locale: 'tr', last_class: last, last_notified_on: null, ...extra,
  });
  const noon = new Date('2026-07-02T09:00:00Z');
  const ok = async (m: any[]) => m.map(() => ({ success: true, deadToken: false }));

  await b('job: nothing at night', async () => {
    const { db } = fakeDb([row('a', '1', 1)]);
    const stats = await risk.runPlaceRiskAlerts(db as any, ok as any, async () => ({ level: 3, score: 90 }), new Date('2026-07-01T23:00:00Z'));
    assert.strictEqual(stats.skipped, true);
  });
  await b('job: one push per device naming the worst place; neighbours share a sample', async () => {
    const { db, saved } = fakeDb([row('a', '1', 1), row('b', '1', 1)]);
    const sent: any[] = [];
    let samples = 0;
    const stats = await risk.runPlaceRiskAlerts(db as any, (async (m: any[]) => { sent.push(...m); return ok(m); }) as any, async () => { samples++; return { level: 2, score: 60 }; }, noon);
    assert.strictEqual(samples, 1);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(stats.pushesSent, 1);
    assert.match(sent[0].body, /\+1 tanesi daha/);
    assert.strictEqual(saved.length, 2);
    assert.strictEqual(saved.every((p) => p[3] === true), true);
  });
  await b('job: below High records the check and sends nothing', async () => {
    const { db, saved } = fakeDb([row('a', '1', 1)]);
    const sent: any[] = [];
    await risk.runPlaceRiskAlerts(db as any, (async (m: any[]) => { sent.push(...m); return ok(m); }) as any, async () => ({ level: 0, score: 10 }), noon);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(saved[0][1], 0);
    assert.strictEqual(saved[0][3], false);
  });
  await b('job: a failed sample or push is retried next tick', async () => {
    const a = fakeDb([row('a', '1', 1)]);
    const stats = await risk.runPlaceRiskAlerts(a.db as any, ok as any, async () => { throw new Error('net'); }, noon);
    assert.strictEqual(stats.sampleErrors, 1);
    assert.strictEqual(a.saved.length, 0);
    const b2 = fakeDb([row('a', '1', 1)]);
    await risk.runPlaceRiskAlerts(b2.db as any, (async (m: any[]) => m.map(() => ({ success: false, deadToken: false }))) as any, async () => ({ level: 2, score: 60 }), noon);
    assert.strictEqual(b2.saved.length, 0);
  });
  await b('policy describes the search and Nominatim in both languages', () => {
    const legal = src('src/routes/legal.ts');
    assert.match(legal, /Arama metni kaydedilmez ve kayıtlara yazılmaz/);
    assert.match(legal, /The search text is not stored or logged/);
    assert.match(legal, /Nominatim<\/a> ile yapılır; veriler © OpenStreetMap katkıcıları/);
    assert.match(legal, /en fazla 7 gün/);
  });
  await b('the job runs in the ingest tick', () => {
    assert.match(src('src/jobs/fireIngestJob.ts'), /await placeRiskJob\.run\(\)/);
  });

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
