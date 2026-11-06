/**
 * Writes database/migrations/013_neighbour_borders.sql from the Natural
 * Earth 1:50m admin-0 countries GeoJSON (public domain), the same dataset
 * migration 003 took Turkey's outline from.
 *
 *   npx ts-node --project tsconfig.scripts.json \
 *     scripts/make-neighbour-borders-migration.ts path/to/ne_50m_admin_0_countries.geojson
 *
 * The migration stores the eight land neighbours and rebuilds Turkey's
 * ingest gate so the tolerance is 1.5 km across a land border and 5 km
 * along the coast: gate = buffer(outline, 5 km) minus the part of the
 * neighbours' territory that is further than 1.5 km from the outline.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NEIGHBOURS: Record<string, string> = {
  GRC: 'Greece',
  BGR: 'Bulgaria',
  GEO: 'Georgia',
  ARM: 'Armenia',
  AZE: 'Azerbaijan',
  IRN: 'Iran',
  IRQ: 'Iraq',
  SYR: 'Syria',
};

const source = process.argv[2];
if (!source) {
  console.error('usage: make-neighbour-borders-migration.ts <ne_50m_admin_0_countries.geojson>');
  process.exit(1);
}

interface Feature { properties: Record<string, unknown>; geometry: unknown }
const features = (JSON.parse(readFileSync(source, 'utf8')) as { features: Feature[] }).features;

const rows: string[] = [];
for (const [iso, name] of Object.entries(NEIGHBOURS)) {
  const f = features.find((x) => x.properties.ADM0_A3 === iso || x.properties.ISO_A3 === iso);
  if (!f) throw new Error(`${iso} not in ${source}`);
  const geojson = JSON.stringify(f.geometry).replace(/'/g, "''");
  rows.push(
    `INSERT INTO country_neighbours (iso_a3, name, source, geom)\n` +
    `SELECT '${iso}', '${name}', 'Natural Earth 1:50m admin-0 (public domain)',\n` +
    `       ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON('${geojson}'), 4326))\n` +
    `ON CONFLICT (iso_a3) DO UPDATE SET geom = EXCLUDED.geom, name = EXCLUDED.name, source = EXCLUDED.source;`
  );
}

const sql = `-- 013: land neighbours, and a border gate that is tighter on land than at sea.
--
-- 012 narrowed the ingest gate to 1.5 km all around. On the land borders
-- that is what we want; on the coast the Natural Earth 1:50m outline is too
-- coarse for it, and detections on Turkish shores (Yalova, Kırklareli's
-- Black Sea coast) would be rejected. The gate is now the 5 km buffer with
-- the neighbours' territory beyond 1.5 km cut out:
--
--   gate = buffer(outline, 5 km) - (neighbours - buffer(outline, 1.5 km))
--
-- Geometry comes from Natural Earth 1:50m admin-0 (public domain), the same
-- dataset as Turkey's outline in 003, so shared borders coincide. Generated
-- by scripts/make-neighbour-borders-migration.ts; do not edit by hand.
-- Idempotent: re-running updates the rows and rebuilds the gate.

CREATE TABLE IF NOT EXISTS country_neighbours (
  iso_a3 TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  source TEXT NOT NULL,
  geom   geometry(MultiPolygon, 4326) NOT NULL
);

${rows.join('\n\n')}

UPDATE country_borders b
   SET geom_gate = ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_Difference(
         ST_Buffer(b.geom::geography, 5000)::geometry,
         ST_Difference(
           (SELECT ST_Union(n.geom) FROM country_neighbours n),
           ST_Buffer(b.geom::geography, 1500)::geometry
         )
       )), 3))
 WHERE b.iso_a3 = 'TUR';
`;

const out = join(__dirname, '..', 'database', 'migrations', '013_neighbour_borders.sql');
writeFileSync(out, sql);
console.log(`wrote ${out} (${sql.length} bytes, ${rows.length} neighbours)`);
