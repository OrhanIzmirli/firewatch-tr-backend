/**
 * Checks the ingest border gate migrations (database/migrations/012, 013)
 * without a database: the files must build the gate the ingest relies on,
 * 1.5 km across the land borders and 5 km along the coast, from the eight
 * land neighbours.
 *
 *   npm run test:border-gate
 *
 * Measured on the live database on 2026-11-07 when 013 was applied: of the
 * 1,734 stored detections 1.5–5 km outside the outline, 155 on the coast
 * (Yalova 139, Kocaeli 11, Samsun 2, İstanbul, İzmir, Adana) are inside the
 * new gate and 1,579 on the land borders (Mardin 846, Şırnak 343,
 * Şanlıurfa 225, Kırklareli 49, Kilis 34, Iğdır 29, Edirne 14, ...) are
 * outside; gate area 812,631 km² (5 km) -> 790,293 (1.5 km) -> 805,059.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failures = 0;
const b = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

const migration = (name: string) => readFileSync(join(__dirname, '..', 'database', 'migrations', name), 'utf8');
const m012 = migration('012_border_gate_1500m.sql');
const m013 = migration('013_neighbour_borders.sql');
const ingest = readFileSync(join(__dirname, '..', 'src', 'jobs', 'fireIngestJob.ts'), 'utf8');

b('012 rebuilds the gate at 1.5 km', () => {
  assert.match(m012, /UPDATE country_borders\s+SET geom_gate = ST_Multi\(ST_Buffer\(geom::geography, 1500\)::geometry\)\s+WHERE iso_a3 = 'TUR'/);
});

b('013 stores the eight land neighbours from Natural Earth', () => {
  for (const iso of ['GRC', 'BGR', 'GEO', 'ARM', 'AZE', 'IRN', 'IRQ', 'SYR']) {
    assert.match(m013, new RegExp(`SELECT '${iso}', '[A-Za-z]+', 'Natural Earth 1:50m admin-0 \\(public domain\\)'`), iso);
  }
  assert.strictEqual((m013.match(/INSERT INTO country_neighbours/g) ?? []).length, 8);
  assert.match(m013, /CREATE TABLE IF NOT EXISTS country_neighbours/);
  assert.match(m013, /ON CONFLICT \(iso_a3\) DO UPDATE/, 'must be re-runnable');
});

b('013 gate: 5 km buffer minus neighbour territory beyond 1.5 km', () => {
  const update = m013.slice(m013.indexOf('UPDATE country_borders'));
  assert.match(update, /ST_Buffer\(b\.geom::geography, 5000\)/);
  assert.match(update, /ST_Difference\(\s*\(SELECT ST_Union\(n\.geom\) FROM country_neighbours n\),\s*ST_Buffer\(b\.geom::geography, 1500\)/);
  assert.match(update, /ST_MakeValid/);
  assert.match(update, /geometry\(MultiPolygon, 4326\)|ST_Multi\(ST_CollectionExtract/);
  assert.match(update, /WHERE b\.iso_a3 = 'TUR'/);
});

b('the ingest still gates on geom_gate, so the migrations change what is accepted', () => {
  assert.match(ingest, /SELECT geom_gate FROM country_borders WHERE iso_a3 = 'TUR'/);
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
