/**
 * Land cover rule and the "confirmed by news" match.
 *
 *   npm run test:incident-evidence
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://nobody@127.0.0.1:1/none';
/* eslint-disable @typescript-eslint/no-var-requires */
const lc = require('../src/services/landCover') as typeof import('../src/services/landCover');
const nm = require('../src/services/incidentNewsMatch') as typeof import('../src/services/incidentNewsMatch');
const job = require('../src/jobs/incidentEvidenceJob') as typeof import('../src/jobs/incidentEvidenceJob');

let failures = 0;
async function b(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
}
const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

const districts = [
  { id: 1, name: 'Datça', provinceId: 48, provinceName: 'Muğla', lat: 36.73, lng: 27.68 },
  { id: 2, name: 'Bodrum', provinceId: 48, provinceName: 'Muğla', lat: 37.03, lng: 27.43 },
  { id: 3, name: 'Urla', provinceId: 35, provinceName: 'İzmir', lat: 38.32, lng: 26.76 },
];
const ctx = { cityNames: ['Muğla', 'İzmir', 'Antalya'], districts };
const at = new Date('2026-08-10T09:00:00Z');
const incident = { id: 10, city: 'Muğla', lat: 36.75, lng: 27.7, firstAt: at, lastAt: at };
const article = (over: Partial<import('../src/services/incidentNewsMatch').MatchArticle> = {}) => ({
  id: 100,
  title: "Muğla'nın Datça ilçesinde orman yangını çıktı",
  summary: "Datça'da ormanlık alanda çıkan yangına ekipler müdahale ediyor.",
  publishedAt: new Date('2026-08-10T12:00:00Z'),
  ...over,
});

(async () => {
  await b('measured cases: stubble, forest, the steelworks', () => {
    assert.strictEqual(lc.classifyLandCover({ crop: 91, grass: 7, tree: 2 }), 'agriculture');
    assert.strictEqual(lc.classifyLandCover({ tree: 49, grass: 48, shrub: 3 }), 'natural');
    assert.strictEqual(lc.classifyLandCover({ bare: 19, built: 62, tree: 8, water: 10 }), 'built');
  });
  await b('mixed windows', () => {
    assert.strictEqual(lc.classifyLandCover({ grass: 60, crop: 38, tree: 1 }), 'agriculture', 'fallow mapped as grass');
    assert.strictEqual(lc.classifyLandCover({ tree: 40, crop: 40, grass: 20 }), 'natural', 'forest edge');
    assert.strictEqual(lc.classifyLandCover({ bare: 80, grass: 20 }), 'other');
  });
  await b('tile names follow the 3 degree grid', () => {
    assert.strictEqual(lc.worldCoverTileName(39.05, 33.6), 'N39E033');
    assert.strictEqual(lc.worldCoverTileName(36.73, 36.2), 'N36E036');
    assert.strictEqual(lc.worldCoverTileName(41.08, 27.02), 'N39E027');
  });
  await b('shares are percentages of the window', () => {
    assert.deepStrictEqual(lc.sharesFromPixels([40, 40, 40, 10]), { crop: 75, tree: 25 });
  });
  await b('the rule in SQL keeps the unclassified', () => {
    const sql = lc.naturalOrConfirmedSql('i');
    assert.match(sql, /land_cover IS NULL/);
    assert.match(sql, /news_verified_id IS NOT NULL/);
  });

  await b('match: forest fire, province, district, near, same day', () => {
    assert.ok((nm.confirmationDistanceKm(incident, article(), ctx) ?? 99) < 15);
  });
  await b('day window: day before and next day pass, two days do not', () => {
    assert.notStrictEqual(nm.confirmationDistanceKm(incident, article({ publishedAt: new Date('2026-08-11T20:00:00Z') }), ctx), null);
    assert.strictEqual(nm.confirmationDistanceKm(incident, article({ publishedAt: new Date('2026-08-12T22:00:00Z') }), ctx), null);
    assert.notStrictEqual(nm.confirmationDistanceKm(incident, article({ publishedAt: new Date('2026-08-09T10:00:00Z') }), ctx), null);
    assert.strictEqual(nm.confirmationDistanceKm(incident, article({ publishedAt: new Date('2026-08-08T10:00:00Z') }), ctx), null);
  });
  await b('refuses: province only', () => {
    assert.strictEqual(nm.confirmationDistanceKm(incident, article({ title: "Muğla'da orman yangını çıktı", summary: 'Ekipler müdahale ediyor.' }), ctx), null);
  });
  await b('refuses: two districts', () => {
    assert.strictEqual(nm.confirmationDistanceKm(incident, article({ summary: "Datça'da ve Bodrum'da orman yangını" }), ctx), null);
  });
  await b('refuses: two provinces in a roundup', () => {
    assert.strictEqual(nm.confirmationDistanceKm(incident, article({ summary: "Datça'da yangın sürerken Antalya ve İzmir'de de orman yangını çıktı" }), ctx), null);
  });
  await b('refuses: another province', () => {
    assert.strictEqual(nm.confirmationDistanceKm({ ...incident, city: 'İzmir' }, article(), ctx), null);
  });
  await b('refuses: right district, too far', () => {
    assert.strictEqual(nm.confirmationDistanceKm({ ...incident, lat: 37.1, lng: 28.2 }, article(), ctx), null);
  });
  await b('refuses: a building fire', () => {
    assert.strictEqual(nm.confirmationDistanceKm(incident, article({ title: "Datça'da otel yangını", summary: 'Muğla Datça ilçesinde binada yangın çıktı.' }), ctx), null);
  });
  await b('an article confirms only the closest incident', () => {
    const near = { ...incident, id: 1, lat: 36.74, lng: 27.69 };
    const far = { ...incident, id: 2, lat: 36.8, lng: 27.75 };
    const m = nm.matchIncidentsToNews([far, near], [article()], ctx);
    assert.deepStrictEqual([...m], [[1, 100]]);
  });

  const fakeDb = (rows: any[]) => {
    const updates: any[][] = [];
    return { updates, db: { query: async (sql: string, p?: unknown[]) => {
      if (/UPDATE fire_incidents SET land_cover/.test(sql)) updates.push(p as any[]);
      return { rows: /land_cover IS NULL/.test(sql) ? rows : [] };
    } } as any };
  };
  await b('job: classifies, and a failed lookup stays pending', async () => {
    const { db, updates } = fakeDb([{ id: 1, lat: '39', lng: '33' }, { id: 2, lat: '40', lng: '34' }]);
    const stats = { classified: 0, failed: 0, matched: 0 };
    await job.classifyPendingLandCover(db, async (lat) => { if (lat === 40) throw new Error('net'); return { crop: 90, grass: 10 }; }, stats);
    assert.deepStrictEqual(stats, { classified: 1, failed: 1, matched: 0 });
    assert.deepStrictEqual(updates.map((u) => u.slice(0, 2)), [[1, 'agriculture']]);
  });
  await b('job order: alerts run after the evidence', () => {
    const s = src('src/jobs/fireIngestJob.ts');
    assert.ok(s.indexOf('incidentEvidenceJob.run()') > s.indexOf('fireClusterJob.runClustering()'));
    assert.ok(s.indexOf('incidentEvidenceJob.run()') < s.indexOf('placeAlertJob.run()'));
  });
  await b('fire alerts use the rule', () => {
    assert.match(src('src/jobs/placeAlertJob.ts'), /naturalOrConfirmedSql\('i'\)/);
  });

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
})();
