import type { Pool } from 'pg';
import cacheService from './cacheService';
import { heatSourceSqlCondition } from './heatSource';
import { loadPipelineState } from './detectionStatus';
import { NEARBY_FIRE_WINDOW_HOURS } from './nearbyFireCount';
import { resolveProvince } from './provinces';
import { calculateRisk } from './riskScore';
import type { WeatherData } from './weatherProviders';
import { WeatherCaller, roundToWeatherGrid, weatherSource } from './weatherSource';

/**
 * The FireWatch risk score at one point: "Konumum", a saved place, and the
 * alert for a saved place. Same formula as the regions (services/riskScore.ts);
 * only the inputs are local: the weather at the point and the satellite
 * events within NEARBY_RISK_RADIUS_KM of it in the last 24 hours.
 *
 * The radius is fixed, not the place's alert radius, so changing how far a
 * place's alerts reach cannot change its risk score.
 *
 * Privacy: the point is rounded to about 10 km (0.1 degree) before anything
 * is done with it. That is what goes to the weather services and what the
 * short-lived cache is keyed by; nothing here is written to the database.
 */

export const NEARBY_RISK_RADIUS_KM = 50;
export const POINT_RISK_CACHE_SECONDS = 15 * 60;

export interface PointRisk {
  latitude: number;
  longitude: number;
  city: string | null;
  region: string | null;
  general_risk_score: number;
  risk_level: string;
  temperature: number;
  humidity: number;
  wind_speed: number;
  wind_direction: string;
  dryness_index: number;
  vegetation_density: number;
  /** Null when the satellite pipeline is stale: unknown, never zero. */
  nearby_fire_count: number | null;
  nearby_radius_km: number;
  /** When this was calculated, ISO 8601. */
  date: string;
}

export function roundToPointGrid(value: number): number {
  return roundToWeatherGrid(value);
}

export function nearbyIncidentCountSql(): string {
  return `SELECT count(*)::int AS n
            FROM fire_incidents i
           WHERE i.last_detected_at > now() - make_interval(hours => $3)
             AND ST_DWithin(
                   i.centroid::geography,
                   ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                   $4
                 )
             AND NOT COALESCE((${heatSourceSqlCondition('i')}), false)`;
}

/** Events near the point, or null when the pipeline cannot vouch for them. */
export async function loadNearbyIncidentCount(
  db: Pick<Pool, 'query'>,
  lat: number,
  lng: number
): Promise<number | null> {
  try {
    if (!(await loadPipelineState(db)).fresh) return null;
    const result = await db.query(nearbyIncidentCountSql(), [
      lng,
      lat,
      NEARBY_FIRE_WINDOW_HOURS,
      NEARBY_RISK_RADIUS_KM * 1000,
    ]);
    return Number(result.rows[0].n);
  } catch (error) {
    console.error('point risk: nearby count unavailable:', (error as Error).message);
    return null;
  }
}

export interface PointRiskDeps {
  weather: (lat: number, lng: number) => Promise<WeatherData>;
  nearby: (lat: number, lng: number) => Promise<number | null>;
  province: (lat: number, lng: number) => Promise<{ name: string; region: string | null } | null>;
  cache: { get<T>(key: string): Promise<T | null>; set<T>(key: string, value: T, ttl?: number): Promise<boolean> };
  now: () => Date;
}

export function defaultPointRiskDeps(db: Pick<Pool, 'query'>, caller: WeatherCaller = 'point'): PointRiskDeps {
  return {
    weather: async (lat, lng) => (await weatherSource.read(lat, lng, caller)).weather,
    nearby: (lat, lng) => loadNearbyIncidentCount(db, lat, lng),
    province: (lat, lng) => resolveProvince(db, lat, lng),
    cache: cacheService,
    now: () => new Date(),
  };
}

/** Throws when the weather cannot be read: a score needs its weather. */
export async function computePointRisk(rawLat: number, rawLng: number, deps: PointRiskDeps): Promise<PointRisk> {
  const lat = roundToPointGrid(rawLat);
  const lng = roundToPointGrid(rawLng);
  const key = `risk:point:v1:${lat}:${lng}`;
  const cached = await deps.cache.get<PointRisk>(key);
  if (cached) return cached;

  const [weather, nearby, province] = await Promise.all([
    deps.weather(lat, lng),
    deps.nearby(lat, lng),
    deps.province(lat, lng).catch(() => null),
  ]);
  const risk = calculateRisk(weather, nearby ?? 0);
  const result: PointRisk = {
    latitude: lat,
    longitude: lng,
    city: province?.name ?? null,
    region: province?.region ?? null,
    general_risk_score: risk.score,
    risk_level: risk.level,
    temperature: weather.temperature,
    humidity: weather.humidity,
    wind_speed: weather.windSpeed,
    wind_direction: weather.windDirection,
    dryness_index: risk.drynessIndex,
    vegetation_density: risk.vegetationPressure,
    nearby_fire_count: nearby,
    nearby_radius_km: NEARBY_RISK_RADIUS_KM,
    date: deps.now().toISOString(),
  };
  await deps.cache.set(key, result, POINT_RISK_CACHE_SECONDS);
  return result;
}
