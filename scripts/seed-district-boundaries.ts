/**
 * Loads district polygons into turkey_district_boundaries (migration 010)
 * from geoBoundaries TUR ADM2, matched by name to our turkey_districts rows.
 *
 *   npm run seed:district-boundaries               # download from the pinned release
 *   npm run seed:district-boundaries -- --adm2 path/to/ADM2.geojson --adm1 path/to/ADM1.geojson
 *   npm run seed:district-boundaries -- --dry-run  # report only, write nothing
 *
 * Source: geoBoundaries (www.geoboundaries.org), gbOpen release, Türkiye
 * ADM2 (districts) and ADM1 (provinces), derived from OpenStreetMap under
 * ODbL. Pinned to one release commit so a re-run loads the same polygons.
 *
 * Matching, in order:
 *   1. Which province is the polygon in?  Its representative point is tested
 *      against the 81 ADM1 polygons (no name involved — ADM2 features carry
 *      no parent name).
 *   2. Which of OUR districts in that province is it?  By name, through
 *      districtBoundaryMatch (handles "X merkez", exonyms, spelling drift).
 *   3. Sanity: does our stored centroid fall inside the chosen polygon?  A
 *      miss is reported but NOT fatal — the centroids come from a different
 *      source and metropolitan centre districts are small and adjacent.
 *
 * REFUSES to load when two polygons resolve to the same district, or a
 * polygon resolves to nothing: those are printed for a human, the rest is
 * loaded, and the exit code says whether everything matched.
 */
import 'dotenv/config';
import fs from 'node:fs';
import axios from 'axios';
import { Pool } from 'pg';
import {
  DistrictNameRef,
  matchDistrictName,
  normalizeDistrictName,
} from '../src/services/districtBoundaryMatch';

const RELEASE = '9469f09';
const BASE = `https://github.com/wmgeolab/geoBoundaries/raw/${RELEASE}/releaseData/gbOpen/TUR`;
const ADM2_URL = `${BASE}/ADM2/geoBoundaries-TUR-ADM2.geojson`;
const ADM1_URL = `${BASE}/ADM1/geoBoundaries-TUR-ADM1.geojson`;
const SOURCE = `geoBoundaries gbOpen TUR ADM2 @${RELEASE} (OpenStreetMap, ODbL)`;

type Ring = number[][];
type PolygonCoords = Ring[];
interface Geometry {
  type: 'Polygon' | 'MultiPolygon';
  coordinates: PolygonCoords | PolygonCoords[];
}
interface Feature {
  properties: { shapeName: string; shapeID?: string };
  geometry: Geometry;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}
const DRY_RUN = process.argv.includes('--dry-run');

async function loadGeoJson(localPath: string | null, url: string): Promise<Feature[]> {
  if (localPath) return JSON.parse(fs.readFileSync(localPath, 'utf8')).features;
  console.log(`Downloading ${url}`);
  const response = await axios.get(url, { responseType: 'json', timeout: 300_000, maxContentLength: 200 * 1024 * 1024 });
  return response.data.features;
}

// --- point in polygon (ray casting; holes honoured) ------------------------

function inRing(pt: number[], ring: Ring): boolean {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inPolygon(pt: number[], poly: PolygonCoords): boolean {
  if (!inRing(pt, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(pt, poly[k])) return false;
  return true;
}
function contains(pt: number[], geom: Geometry): boolean {
  return geom.type === 'Polygon'
    ? inPolygon(pt, geom.coordinates as PolygonCoords)
    : (geom.coordinates as PolygonCoords[]).some((p) => inPolygon(pt, p));
}

/** A point guaranteed inside: the centroid of the largest ring, else a vertex-midpoint scan. */
function representativePoint(geom: Geometry): number[] {
  const polys = geom.type === 'Polygon' ? [geom.coordinates as PolygonCoords] : (geom.coordinates as PolygonCoords[]);
  const outer = polys.map((p) => p[0]).sort((a, b) => b.length - a.length)[0];
  const c = outer.reduce((acc, p) => [acc[0] + p[0] / outer.length, acc[1] + p[1] / outer.length], [0, 0]);
  if (contains(c, geom)) return c;
  // Concave shape: walk midpoints between the centroid and vertices.
  for (const v of outer) {
    const mid = [(c[0] + v[0]) / 2, (c[1] + v[1]) / 2];
    if (contains(mid, geom)) return mid;
  }
  return outer[0];
}

// ---------------------------------------------------------------------------

async function main() {
  if (!process.env.DATABASE_URL && !DRY_RUN) throw new Error('DATABASE_URL is required');
  const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true }, max: 2 })
    : null;

  const [adm2, adm1] = await Promise.all([
    loadGeoJson(arg('--adm2'), ADM2_URL),
    loadGeoJson(arg('--adm1'), ADM1_URL),
  ]);
  console.log(`ADM2 polygons: ${adm2.length}, ADM1 provinces: ${adm1.length}`);

  let districts: (DistrictNameRef & { lat: number; lng: number })[];
  if (pool) {
    const result = await pool.query(
      `SELECT id, name, province_name, ST_Y(location) AS lat, ST_X(location) AS lng FROM turkey_districts`
    );
    districts = result.rows.map((r: any) => ({
      id: Number(r.id), name: String(r.name), provinceName: String(r.province_name),
      lat: Number(r.lat), lng: Number(r.lng),
    }));
  } else {
    // Dry run without a database: use the seed file with synthetic ids.
    const seed = JSON.parse(fs.readFileSync('database/seed/turkey_districts.json', 'utf8'));
    districts = seed.map((r: any, i: number) => ({
      id: i + 1, name: String(r.district), provinceName: String(r.province), lat: r.lat, lng: r.lng,
    }));
  }
  console.log(`Our districts: ${districts.length}`);

  const byProvince = new Map<string, typeof districts>();
  for (const d of districts) {
    const key = normalizeDistrictName(d.provinceName);
    byProvince.set(key, [...(byProvince.get(key) ?? []), d]);
  }

  const matched = new Map<number, { feature: Feature; provinceName: string }>();
  const unmatched: string[] = [];
  const conflicts: string[] = [];
  const centroidMisses: string[] = [];

  for (const feature of adm2) {
    const rep = representativePoint(feature.geometry);
    const province = adm1.find((p) => contains(rep, p.geometry));
    if (!province) {
      unmatched.push(`${feature.properties.shapeName} (province not resolved)`);
      continue;
    }
    const provinceName = province.properties.shapeName;
    const candidates = byProvince.get(normalizeDistrictName(provinceName)) ?? [];
    if (candidates.length === 0) {
      unmatched.push(`${feature.properties.shapeName} (province "${provinceName}" unknown to us)`);
      continue;
    }
    const hit = matchDistrictName(feature.properties.shapeName, provinceName, candidates);
    if (!hit) {
      unmatched.push(`${feature.properties.shapeName} @ ${provinceName}`);
      continue;
    }
    const previous = matched.get(hit.id);
    if (previous) {
      conflicts.push(
        `${hit.name}/${provinceName} ← both "${previous.feature.properties.shapeName}" and "${feature.properties.shapeName}"`
      );
      matched.delete(hit.id);
      continue;
    }
    matched.set(hit.id, { feature, provinceName });
    const ours = districts.find((d) => d.id === hit.id)!;
    if (!contains([ours.lng, ours.lat], feature.geometry)) {
      centroidMisses.push(`${hit.name}/${provinceName} ← "${feature.properties.shapeName}"`);
    }
  }

  console.log(`\nMatched: ${matched.size} of ${adm2.length} polygons`);
  console.log(`Our districts without a polygon: ${districts.length - matched.size}`);
  if (centroidMisses.length) {
    console.log(`\nCentroid outside chosen polygon (${centroidMisses.length}, review by eye):`);
    for (const m of centroidMisses) console.log('  ~', m);
  }
  if (conflicts.length) {
    console.log(`\nCONFLICTS — two polygons for one district (${conflicts.length}, neither loaded):`);
    for (const c of conflicts) console.log('  ✗', c);
  }
  if (unmatched.length) {
    console.log(`\nUNMATCHED polygons (${unmatched.length}, not loaded):`);
    for (const u of unmatched) console.log('  ?', u);
  }

  if (DRY_RUN || !pool) {
    console.log('\nDry run: nothing written.');
    process.exit(unmatched.length + conflicts.length === 0 ? 0 : 2);
  }

  let written = 0;
  for (const [districtId, { feature }] of matched) {
    await pool.query(
      `INSERT INTO turkey_district_boundaries (district_id, geom, source, source_name, source_id)
       VALUES ($1, ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($2), 4326))), $3, $4, $5)
       ON CONFLICT (district_id) DO UPDATE
          SET geom = EXCLUDED.geom, source = EXCLUDED.source,
              source_name = EXCLUDED.source_name, source_id = EXCLUDED.source_id`,
      [districtId, JSON.stringify(feature.geometry), SOURCE, feature.properties.shapeName, feature.properties.shapeID ?? null]
    );
    written++;
  }
  const count = await pool.query(`SELECT count(*)::int AS n FROM turkey_district_boundaries`);
  console.log(`\nWrote ${written} polygons; table now holds ${count.rows[0].n}.`);
  await pool.end();
  process.exit(unmatched.length + conflicts.length === 0 ? 0 : 2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
