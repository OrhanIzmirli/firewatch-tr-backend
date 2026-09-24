/**
 * Loads database/seed/turkey_districts.json into turkey_districts.
 *
 *   DATABASE_URL=... npm run seed:districts
 *
 * Idempotent: keyed on (province_id, name), re-running updates coordinates
 * in place. Refuses to load anything if even one province name in the seed
 * cannot be matched to a turkey_cities row — a district attached to the
 * wrong province would put its fires in the wrong region's alerts, and
 * "most of them loaded" is not a state worth having.
 */
import fs from 'node:fs';
import path from 'node:path';
import pool from '../src/config/database';
import { turkishToLower } from '../src/utils/turkishText';

const SEED_PATH = path.join(__dirname, '..', 'database', 'seed', 'turkey_districts.json');
const SOURCE = 'caglarsarikaya/turkey-geolocations (GitHub, OSM-derived centroids)';

interface SeedRow {
  province: string;
  district: string;
  lat: number;
  lng: number;
}

/**
 * turkey_cities predates this repo and keeps one province under its former
 * official name. The seed uses the current one; map it rather than edit a
 * table the API already keys alerts on.
 */
const PROVINCE_ALIASES: Record<string, string> = {
  mersin: 'İçel',
};

/** 'İçel', 'Icel' and 'içel' compare equal; mirrors regions.ts's fold. */
function fold(value: string): string {
  return turkishToLower(value)
    .replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
    .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
    .replace(/\s+/g, ' ').trim();
}

function cityKey(provinceName: string): string {
  return fold(PROVINCE_ALIASES[fold(provinceName)] ?? provinceName);
}

async function main() {
  const raw = fs.readFileSync(SEED_PATH, 'utf8').replace(/^﻿/, '');
  const rows = JSON.parse(raw) as SeedRow[];
  console.log(`seed: ${rows.length} districts`);

  const cities = await pool.query(`SELECT id, name FROM turkey_cities`);
  const cityIdByFolded = new Map<string, number>();
  for (const c of cities.rows) cityIdByFolded.set(fold(String(c.name)), Number(c.id));

  const unmatched = new Set<string>();
  for (const r of rows) {
    if (!cityIdByFolded.has(cityKey(r.province))) unmatched.add(r.province);
  }
  if (unmatched.size > 0) {
    console.error(
      `ABORT: ${unmatched.size} province name(s) in the seed have no turkey_cities row: ` +
        [...unmatched].join(', ')
    );
    process.exit(1);
  }

  let inserted = 0;
  let updated = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      const provinceId = cityIdByFolded.get(cityKey(r.province))!;
      const result = await client.query(
        `INSERT INTO turkey_districts (name, province_id, province_name, location, source)
         VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), $6)
         ON CONFLICT (province_id, name) DO UPDATE
           SET location = EXCLUDED.location,
               province_name = EXCLUDED.province_name,
               source = EXCLUDED.source
         RETURNING (xmax = 0) AS inserted`,
        [r.district, provinceId, r.province, r.lng, r.lat, SOURCE]
      );
      if (result.rows[0]?.inserted) inserted++;
      else updated++;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const total = await pool.query(`SELECT count(*)::int AS n FROM turkey_districts`);
  console.log(`inserted ${inserted}, updated ${updated}, table now holds ${total.rows[0].n}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
