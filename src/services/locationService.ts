import pool from '../config/database';
import { regionKeyForCoordinates, regionKeyForRegionName } from '../utils/regions';

/**
 * Single server-side authority for "which province and region is this
 * coordinate in".
 *
 * Everything that needs a region — device subscriptions, fire alert
 * targeting, detection ingest, the province list — goes through here, so all
 * of them agree.
 *
 * The province's own `turkey_cities.region` column is the authority. The
 * coordinate bounding boxes are only a last resort for rows whose region is
 * missing or spelled in a way we don't recognise.
 *
 * Why not the bounding boxes: they misclassify real provinces. Konya,
 * Karaman, Niğde and Aksaray fall in the 'akdeniz' box but are İç Anadolu;
 * Burdur falls in 'ege' but is Akdeniz. The risk job derives its alert region
 * from turkey_cities vocabulary, so a device tagged from the boxes would sit
 * in a different region than the alert it should have matched — a Konya user
 * on "my region only" would never receive an İç Anadolu alert.
 */
export interface ResolvedLocation {
  cityId: number | null;
  cityName: string | null;
  /** Turkish display name straight from turkey_cities.region. */
  regionName: string | null;
  /** Canonical key, shared with the Flutter client and the risk job. */
  regionKey: string | null;
  distanceKm: number | null;
}

const EMPTY: ResolvedLocation = {
  cityId: null,
  cityName: null,
  regionName: null,
  regionKey: null,
  distanceKm: null,
};

export async function resolveLocation(
  lat: number,
  lng: number
): Promise<ResolvedLocation> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return EMPTY;

  try {
    const result = await pool.query(
      `SELECT id, name, region,
              ST_Distance(
                location::geography,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
              ) / 1000 AS distance_km
       FROM turkey_cities
       ORDER BY location <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
       LIMIT 1`,
      [lng, lat]
    );

    const row = result.rows[0];
    if (!row) return { ...EMPTY, regionKey: regionKeyForCoordinates(lat, lng) };

    return {
      cityId: Number(row.id),
      cityName: row.name ?? null,
      regionName: row.region ?? null,
      regionKey:
        regionKeyForRegionName(row.region) ?? regionKeyForCoordinates(lat, lng),
      distanceKm: Number(row.distance_km),
    };
  } catch (error) {
    console.error('resolveLocation failed:', (error as Error).message);
    // Never let a lookup failure silently drop the region entirely.
    return { ...EMPTY, regionKey: regionKeyForCoordinates(lat, lng) };
  }
}

/** Resolves the region for a province we already know the id of. */
export async function resolveRegionForCity(cityId: number): Promise<string | null> {
  try {
    const result = await pool.query(
      `SELECT region,
              ST_Y(location::geometry) AS lat,
              ST_X(location::geometry) AS lng
       FROM turkey_cities WHERE id = $1`,
      [cityId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return (
      regionKeyForRegionName(row.region) ??
      (row.lat !== null && row.lng !== null
        ? regionKeyForCoordinates(Number(row.lat), Number(row.lng))
        : null)
    );
  } catch (error) {
    console.error('resolveRegionForCity failed:', (error as Error).message);
    return null;
  }
}
