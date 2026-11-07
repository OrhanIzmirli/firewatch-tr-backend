/**
 * No-database checks for the province work (migration 015).
 *
 *   npm run test:provinces
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/test';

/* eslint-disable @typescript-eslint/no-var-requires */
const gen = require('./build-migration-015') as typeof import('./build-migration-015');
const p = require('../src/services/provinces') as typeof import('../src/services/provinces');
const { deviation } = require('./backfill-provinces-015') as typeof import('./backfill-provinces-015');
/* eslint-enable @typescript-eslint/no-var-requires */

let failures = 0;
function t(name: string, fn: () => void) {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
}

t('the boundary file is the pinned one shared with the app, 81 provinces in plate order', () => {
  const { features } = gen.loadBorders();
  assert.strictEqual(features.length, 81);
  assert.strictEqual(features[32].properties.il, 'Mersin');
  assert.strictEqual(features[62].properties.il, 'Şanlıurfa');
});

t('015_province_borders.sql is exactly what the generator produces', () => {
  const current = fs.readFileSync(gen.MIGRATION_PATH, 'utf8').replace(/\r\n/g, '\n');
  assert.strictEqual(current, gen.buildMigration());
});

t('no code picks a province by its centre except the pre-015 fallback', () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.ts') && !f.endsWith(path.join('services', 'provinces.ts'))) {
        const src = fs.readFileSync(f, 'utf8');
        // turkey_cities directly followed by a distance ORDER BY: the old
        // "nearest centre" rule. (Districts ordered inside a province are fine.)
        if (/FROM turkey_cities(?:\s+\w+)?\s+ORDER BY\s+(?:\w+\.)?location\s*<->/.test(src)) offenders.push(f);
      }
    }
  };
  walk(path.join(__dirname, '..', 'src'));
  assert.deepStrictEqual(offenders, []);
});

t('every caller goes through the shared resolver', () => {
  const read = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
  assert.match(read('routes/fires.ts'), /resolveProvince\(pool, lat, lng\)/);
  assert.match(read('routes/fires.ts'), /resolveProvinces\(pool,/);
  assert.match(read('services/locationService.ts'), /resolveProvince\(pool, lat, lng\)/);
  assert.match(read('jobs/fireIngestJob.ts'), /provinceIdSql\('p\.geom', usePolygons\)/);
  assert.match(read('jobs/fireClusterJob.ts'), /province_for_point\(\$\{newCentroid\}\)/);
  assert.match(read('routes/history.ts'), /historySql\(usePolygons\)/);
});

t('Mersin: old and new names', () => {
  assert.strictEqual(p.currentProvinceName('İçel'), 'Mersin');
  assert.strictEqual(p.currentProvinceName('Adana'), 'Adana');
  assert.deepStrictEqual(p.withFormerNames(['Adana', 'Mersin']), ['Adana', 'Mersin', 'İçel']);
  assert.deepStrictEqual(p.canonicalProvinceNames(['İçel', 'Mersin']), ['Mersin']);
  assert.match(p.provinceIdSql('g', true), /province_for_point\(g\)/);
  assert.match(p.provinceIdSql('g', false), /ORDER BY tc\.location <-> g/);
});

t('backfill rolls back beyond 5% of the expected count', () => {
  assert.strictEqual(deviation('incidents', 3340, 3341), null);
  assert.strictEqual(deviation('incidents', 3500, 3341), null); // 4.8%
  assert.match(deviation('incidents', 3600, 3341) ?? '', /7\.8% off/);
  assert.match(deviation('incidents', 3000, 3341) ?? '', /10\.2% off/);
  assert.strictEqual(deviation('incidents', 10, undefined), null);
});

t('privacy page credits geoBoundaries and OpenStreetMap', () => {
  const legal = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'legal.ts'), 'utf8');
  assert.match(legal, /geoBoundaries[\s\S]*OpenStreetMap katkıda bulunanlar/);
  assert.match(legal, /geoBoundaries[\s\S]*OpenStreetMap contributors/);
});

console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
