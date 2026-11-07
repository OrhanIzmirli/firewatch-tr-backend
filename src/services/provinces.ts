import type { Pool, PoolClient } from 'pg';

/**
 * Which province a point is in — the one answer every caller uses.
 *
 * Before migration 015 every "which province" question was answered with
 * the nearest province CENTRE (turkey_cities has one point per province),
 * so a quarter of incidents near a border got the neighbour ("Diyarbakır /
 * Siverek"). Migration 015 adds the real province polygons
 * (turkey_province_borders, geoBoundaries / OpenStreetMap, ODbL) and the
 * SQL function province_for_point(): the province containing the point,
 * or the nearest one for points at sea / just outside the outline.
 *
 * Until the migration is applied the old nearest-centre rule is used, so
 * deploying this code first is harmless.
 */

type Db = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

let polygons: Promise<boolean> | null = null;

/** Whether migration 015 is applied. Only a "yes" is memoised. */
export function provincePolygonsAvailable(db: Db): Promise<boolean> {
  if (!polygons) {
    polygons = db
      .query(`SELECT to_regprocedure('province_for_point(geometry)') IS NOT NULL AS ok`)
      .then((r) => {
        const ok = r.rows[0]?.ok === true;
        if (!ok) polygons = null;
        return ok;
      })
      .catch(() => {
        polygons = null;
        return false;
      });
  }
  return polygons;
}

export function resetProvinceCache(): void {
  polygons = null;
}

/**
 * SQL for the province id of the geometry expression [point] (SRID 4326).
 * The ONLY place in src/ allowed to pick a province by distance to its
 * centre, and only as the pre-015 fallback.
 */
export function provinceIdSql(point: string, usePolygons: boolean): string {
  return usePolygons
    ? `province_for_point(${point})`
    : `(SELECT tc.id FROM turkey_cities tc ORDER BY tc.location <-> ${point} LIMIT 1)`;
}

export interface ResolvedProvince {
  id: number;
  name: string;
  /** turkey_cities.region, Turkish display name ("İç Anadolu"). */
  region: string | null;
  /** Distance to the province's centre, km (what the app shows as "N km"). */
  distanceKm: number;
}

/**
 * Resolves many points in one query, in input order; null where a point
 * could not be resolved (no provinces loaded at all).
 */
export async function resolveProvinces(
  db: Db,
  points: ReadonlyArray<{ lat: number; lng: number }>
): Promise<Array<ResolvedProvince | null>> {
  if (points.length === 0) return [];
  const usePolygons = await provincePolygonsAvailable(db);
  const result = await db.query(
    `WITH pts AS (
       SELECT idx, ST_SetSRID(ST_MakePoint(lng, lat), 4326) AS g
         FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS t(lat, lng, idx)
     ),
     assigned AS (SELECT idx, g, ${provinceIdSql('g', usePolygons)} AS pid FROM pts)
     SELECT a.idx, tc.id, tc.name, tc.region,
            ST_Distance(tc.location::geography, a.g::geography) / 1000 AS distance_km
       FROM assigned a
       LEFT JOIN turkey_cities tc ON tc.id = a.pid
      ORDER BY a.idx`,
    [points.map((p) => p.lat), points.map((p) => p.lng)]
  );
  return result.rows.map((row: any) =>
    row.id === null
      ? null
      : {
          id: Number(row.id),
          name: String(row.name),
          region: row.region === null ? null : String(row.region),
          distanceKm: Number(row.distance_km),
        }
  );
}

export async function resolveProvince(db: Db, lat: number, lng: number): Promise<ResolvedProvince | null> {
  return (await resolveProvinces(db, [{ lat, lng }]))[0] ?? null;
}

/**
 * Former official names people (and news) still use, keyed by the current
 * name. turkey_cities called Mersin "İçel" until migration 015.
 */
export const PROVINCE_FORMER_NAMES: Readonly<Record<string, readonly string[]>> = {
  Mersin: ['İçel'],
};

/** Current name for a current or former name ("İçel" → "Mersin"). */
export function currentProvinceName(name: string): string {
  for (const [current, formers] of Object.entries(PROVINCE_FORMER_NAMES)) {
    if (name === current || formers.includes(name)) return current;
  }
  return name;
}

/** [names] plus the former names of any that have one. */
export function withFormerNames(names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const name of names) {
    out.push(name);
    out.push(...(PROVINCE_FORMER_NAMES[name] ?? []));
  }
  return out;
}

/** Distinct current names for names found in text (former names folded in). */
export function canonicalProvinceNames(found: Iterable<string>): string[] {
  return [...new Set([...found].map(currentProvinceName))];
}
