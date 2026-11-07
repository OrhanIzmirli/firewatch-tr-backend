/**
 * Reassigns existing rows to the province their point is IN (migration 015),
 * replacing the old nearest-province-centre labels.
 *
 *   ts-node --project tsconfig.scripts.json scripts/backfill-provinces-015.ts \
 *     --expect-incidents 3300 --expect-detections 14800 [--dry-run]
 *
 * Run right AFTER deploying the code that assigns new rows the same way,
 * so nothing written in between keeps the old label.
 *
 * - One transaction. Every changed row's old and new city_id / region_key
 *   goes to province_reassign_015 first (a re-run keeps the original old
 *   values), so the change can be undone exactly.
 * - fire_incidents (centroid), fire_detections (point; nearest_city_km is
 *   re-measured to the new province's centre), news_reported_sightings.
 * - ROLLBACK, exit 1, if the number of changed incidents or detections is
 *   more than 5% away from the expected number, or if any row is left whose
 *   region_key disagrees with its province.
 * - Never prints the connection string.
 */
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ quiet: true } as any);

export const MAX_DEVIATION = 0.05;

export interface BackfillCounts {
  incidents: number;
  detections: number;
  sightings: number;
  inconsistent: number;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** null when within tolerance (or nothing expected), else the reason. */
export function deviation(label: string, actual: number, expected: number | undefined): string | null {
  if (expected === undefined) return null;
  if (expected === 0) return actual === 0 ? null : `${label}: expected 0, got ${actual}`;
  const d = Math.abs(actual - expected) / expected;
  return d > MAX_DEVIATION
    ? `${label}: ${actual} changed, expected ${expected} (${(d * 100).toFixed(1)}% off, limit ${MAX_DEVIATION * 100}%)`
    : null;
}

/** The whole backfill inside the caller's transaction. */
export async function backfill(db: Pick<Client, 'query'>): Promise<BackfillCounts> {
  const fn = await db.query(`SELECT to_regprocedure('province_for_point(geometry)') IS NOT NULL AS ok`);
  if (!fn.rows[0].ok) throw new Error('migration 015 is not applied (province_for_point missing)');

  // fire_incidents
  await db.query(`
    CREATE TEMP TABLE bf_incidents ON COMMIT DROP AS
    SELECT i.id, i.city_id AS old_city, i.region_key AS old_region,
           n.pid AS new_city, province_region_key(n.pid) AS new_region
      FROM fire_incidents i
      CROSS JOIN LATERAL (SELECT province_for_point(i.centroid) AS pid) n
     WHERE n.pid IS NOT NULL
       AND (i.city_id IS DISTINCT FROM n.pid OR i.region_key IS DISTINCT FROM province_region_key(n.pid))`);
  await db.query(`
    INSERT INTO province_reassign_015 (table_name, row_id, old_city_id, old_region_key, new_city_id, new_region_key)
    SELECT 'fire_incidents', id, old_city, old_region, new_city, new_region FROM bf_incidents
    ON CONFLICT (table_name, row_id) DO UPDATE
      SET new_city_id = EXCLUDED.new_city_id, new_region_key = EXCLUDED.new_region_key, changed_at = NOW()`);
  const inc = await db.query(`
    UPDATE fire_incidents i SET city_id = b.new_city, region_key = b.new_region
      FROM bf_incidents b WHERE i.id = b.id`);

  // fire_detections
  await db.query(`
    CREATE TEMP TABLE bf_detections ON COMMIT DROP AS
    SELECT d.id, d.city_id AS old_city, d.region_key AS old_region,
           n.pid AS new_city, province_region_key(n.pid) AS new_region
      FROM fire_detections d
      CROSS JOIN LATERAL (SELECT province_for_point(d.geom) AS pid) n
     WHERE n.pid IS NOT NULL
       AND (d.city_id IS DISTINCT FROM n.pid OR d.region_key IS DISTINCT FROM province_region_key(n.pid))`);
  await db.query(`
    INSERT INTO province_reassign_015 (table_name, row_id, old_city_id, old_region_key, new_city_id, new_region_key)
    SELECT 'fire_detections', id, old_city, old_region, new_city, new_region FROM bf_detections
    ON CONFLICT (table_name, row_id) DO UPDATE
      SET new_city_id = EXCLUDED.new_city_id, new_region_key = EXCLUDED.new_region_key, changed_at = NOW()`);
  const det = await db.query(`
    UPDATE fire_detections d
       SET city_id = b.new_city, region_key = b.new_region,
           nearest_city_km = ST_Distance(tc.location::geography, d.geom::geography) / 1000
      FROM bf_detections b JOIN turkey_cities tc ON tc.id = b.new_city
     WHERE d.id = b.id`);

  // news_reported_sightings (province_id, from the sighting's location)
  let sightings = 0;
  const hasSightings = await db.query(`SELECT to_regclass('news_reported_sightings') IS NOT NULL AS ok`);
  if (hasSightings.rows[0].ok) {
    await db.query(`
      CREATE TEMP TABLE bf_sightings ON COMMIT DROP AS
      SELECT s.id, s.province_id AS old_city, s.region_key AS old_region,
             n.pid AS new_city, province_region_key(n.pid) AS new_region
        FROM news_reported_sightings s
        CROSS JOIN LATERAL (SELECT province_for_point(s.location::geometry) AS pid) n
       WHERE s.location IS NOT NULL AND n.pid IS NOT NULL
         AND (s.province_id IS DISTINCT FROM n.pid OR s.region_key IS DISTINCT FROM province_region_key(n.pid))`);
    await db.query(`
      INSERT INTO province_reassign_015 (table_name, row_id, old_city_id, old_region_key, new_city_id, new_region_key)
      SELECT 'news_reported_sightings', id, old_city, old_region, new_city, new_region FROM bf_sightings
      ON CONFLICT (table_name, row_id) DO UPDATE
        SET new_city_id = EXCLUDED.new_city_id, new_region_key = EXCLUDED.new_region_key, changed_at = NOW()`);
    const s = await db.query(`
      UPDATE news_reported_sightings s SET province_id = b.new_city, region_key = b.new_region
        FROM bf_sightings b WHERE s.id = b.id`);
    sightings = s.rowCount ?? 0;
  }

  const bad = await db.query(`
    SELECT (SELECT count(*) FROM fire_incidents
             WHERE city_id IS NOT NULL AND region_key IS DISTINCT FROM province_region_key(city_id))
         + (SELECT count(*) FROM fire_detections
             WHERE city_id IS NOT NULL AND region_key IS DISTINCT FROM province_region_key(city_id)) AS n`);

  return {
    incidents: inc.rowCount ?? 0,
    detections: det.rowCount ?? 0,
    sightings,
    inconsistent: Number(bad.rows[0].n),
  };
}

async function main() {
  const expectIncidents = arg('--expect-incidents');
  const expectDetections = arg('--expect-detections');
  const dryRun = process.argv.includes('--dry-run');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '60s'`);
    const t0 = Date.now();
    const counts = await backfill(client);
    console.log(`changed: incidents ${counts.incidents}, detections ${counts.detections}, sightings ${counts.sightings}; ` +
      `inconsistent after update ${counts.inconsistent}; ${Date.now() - t0} ms`);

    const problems = [
      deviation('incidents', counts.incidents, expectIncidents === undefined ? undefined : Number(expectIncidents)),
      deviation('detections', counts.detections, expectDetections === undefined ? undefined : Number(expectDetections)),
      counts.inconsistent > 0 ? `${counts.inconsistent} rows have a region_key that disagrees with their province` : null,
    ].filter((p): p is string => p !== null);

    if (problems.length > 0) {
      await client.query('ROLLBACK');
      console.error('ROLLED BACK: ' + problems.join('; '));
      process.exitCode = 1;
    } else if (dryRun) {
      await client.query('ROLLBACK');
      console.log('dry run: rolled back');
    } else {
      await client.query('COMMIT');
      console.log('committed');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('ROLLED BACK on error:', (error as Error).message.replace(/postgres(ql)?:\/\/\S+/g, '<url>'));
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main();
}
