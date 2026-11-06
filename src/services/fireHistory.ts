import { heatSourceSqlCondition } from './heatSource';

/**
 * Past fires for the app's history screen (GET /api/history), built from
 * fire_incidents — satellite thermal detections clustered into incidents.
 *
 * What this is and is not, so nobody reads more into it than is there:
 *
 *   geometry  "satellite heat detection footprint": a 188 m buffer (half a
 *             VIIRS 375 m pixel) around every detection, merged and
 *             simplified. It shows where the satellite saw heat, NOT the
 *             burn scar; a fire can burn far more or less than this.
 *   area_ha   always null. No measured burned area exists for these
 *             incidents, and a buffer area would invite exactly the
 *             "N football pitches" comparison it cannot support.
 *   district  the district whose centre is nearest the incident centroid,
 *             flagged as such; near a border it can be the neighbour.
 *   source    NASA FIRMS (VIIRS / MODIS active fire), not EFFIS. No
 *             official record exists for these incidents.
 *
 * Inclusion: ≥ 5 detections and not a fixed heat source (decided
 * 2026-11-06). Smaller incidents are mostly single-pass agricultural burns.
 * Agricultural burns with ≥ 5 detections still pass; without land cover
 * they cannot be told apart from wildfires.
 */

export const HISTORY_MIN_DETECTIONS = 5;
/**
 * The app's period presets reach back to June 1 of last year (~520 days) and
 * three years from today (up to 1,097 days inclusive). 1,100 covers both.
 * Payload grows with the data: about 0.8 MB gzipped per 3 months of fire
 * season at today's inclusion rule.
 */
export const HISTORY_MAX_RANGE_DAYS = 1100;
/** Half a VIIRS I-band pixel (375 m), metres. */
export const HISTORY_BUFFER_M = 188;
/** Simplification tolerance in degrees (~55 m at Türkiye's latitude). */
export const HISTORY_SIMPLIFY_DEG = 0.0005;
export const HISTORY_TIME_ZONE = 'Europe/Istanbul';

export const HISTORY_SOURCE = {
  provider: 'NASA FIRMS',
  products: ['VIIRS 375 m active fire (S-NPP, NOAA-20, NOAA-21)', 'MODIS 1 km active fire'],
  url: 'https://firms.modaps.eosdis.nasa.gov/',
  // Verbatim from https://www.earthdata.nasa.gov/data/tools/firms ("Acknowledgments"), checked 2026-11-06.
  attribution:
    'We acknowledge the use of data and/or imagery from NASA\'s Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA\'s Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA\'s Earth Science Data and Information System (ESDIS).',
  geometry_kind: 'satellite_heat_detection_footprint',
  caveat_tr:
    'Harita, uydunun ısı tespit ettiği yerlerin izidir (her tespit çevresinde 188 m); yanan alan sınırı değildir. Yanan alan ölçülmediği için alan bilgisi verilmez. Anız ve tarım yangınları da dahildir.',
  caveat_en:
    'The map shows where the satellite detected heat (188 m around each detection), not the burned-area boundary. Burned area is not measured, so no area is given. Agricultural burns are included.',
} as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form, else null. */
export function parseIsoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return null;
  return value;
}

export type HistoryRange = { from: string; to: string } | { error: string };

/** Validates ?from&to: both required ISO dates, from ≤ to, at most HISTORY_MAX_RANGE_DAYS days. */
export function parseHistoryRange(query: { from?: unknown; to?: unknown }): HistoryRange {
  const from = parseIsoDate(query.from);
  const to = parseIsoDate(query.to);
  if (!from || !to) return { error: 'from and to are required as YYYY-MM-DD dates' };
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days < 0) return { error: 'from must not be after to' };
  if (days + 1 > HISTORY_MAX_RANGE_DAYS) return { error: `range must be at most ${HISTORY_MAX_RANGE_DAYS} days` };
  return { from, to };
}

/**
 * Incidents overlapping [from 00:00, to+1 00:00) Istanbul time — the ending
 * day is inclusive. $1 = from, $2 = to, $3 = min detections.
 */
export function historySql(): string {
  return `
    WITH bounds AS (
      SELECT ($1::date)::timestamp AT TIME ZONE '${HISTORY_TIME_ZONE}' AS lo,
             ($2::date + 1)::timestamp AT TIME ZONE '${HISTORY_TIME_ZONE}' AS hi
    )
    SELECT i.id,
           c.name AS city,
           d.name AS district,
           to_char(i.first_detected_at AT TIME ZONE '${HISTORY_TIME_ZONE}', 'YYYY-MM-DD') AS date_start,
           to_char(i.last_detected_at AT TIME ZONE '${HISTORY_TIME_ZONE}', 'YYYY-MM-DD') AS date_end,
           i.first_detected_at,
           i.last_detected_at,
           i.detection_count,
           i.max_frp_mw,
           ST_X(i.centroid) AS lng,
           ST_Y(i.centroid) AS lat,
           ST_AsGeoJSON(
             ST_CollectionExtract(
               ST_SimplifyPreserveTopology(
                 ST_Buffer(i.footprint::geography, ${HISTORY_BUFFER_M}, 'quad_segs=2')::geometry,
                 ${HISTORY_SIMPLIFY_DEG}
               ), 3),
             5
           ) AS geometry
      FROM fire_incidents i
      CROSS JOIN bounds b
      LEFT JOIN turkey_cities c ON c.id = i.city_id
      LEFT JOIN LATERAL (
        SELECT td.name FROM turkey_districts td
         ORDER BY td.location <-> i.centroid
         LIMIT 1
      ) d ON true
     WHERE i.first_detected_at < b.hi
       AND i.last_detected_at >= b.lo
       AND i.detection_count >= $3
       AND NOT COALESCE((${heatSourceSqlCondition('i')}), false)
     ORDER BY i.first_detected_at DESC, i.id DESC`;
}

/**
 * The FIRMS Fire Map. Deliberately not a deep link to the incident: the
 * map's URL-hash format (dates, centre) is undocumented and could not be
 * confirmed on 2026-11-06, and a wrong link is worse than a general one.
 */
export const FIRMS_MAP_URL = 'https://firms.modaps.eosdis.nasa.gov/map/';

const round1 = (n: number) => Math.round(n * 10) / 10;
const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

export interface HistoryRow {
  id: number | string;
  city: string | null;
  district: string | null;
  date_start: string;
  date_end: string;
  first_detected_at: Date | string;
  last_detected_at: Date | string;
  detection_count: number | string;
  max_frp_mw: number | string | null;
  lng: number | string;
  lat: number | string;
  geometry: string | null;
}

/** One GeoJSON Feature in the app contract's shape. */
export function toHistoryFeature(row: HistoryRow) {
  const durationMs = new Date(row.last_detected_at).getTime() - new Date(row.first_detected_at).getTime();
  return {
    type: 'Feature' as const,
    id: Number(row.id),
    geometry: row.geometry ? JSON.parse(row.geometry) : null,
    properties: {
      city: row.city,
      district: row.district,
      district_basis: row.district ? 'nearest_district_center' : null,
      date_start: row.date_start,
      date_end: row.date_end,
      area_ha: null,
      detection_count: Number(row.detection_count),
      duration_hours: round1(Math.max(0, durationMs) / 3_600_000),
      max_frp_mw: row.max_frp_mw === null ? null : round1(Number(row.max_frp_mw)),
      geometry_kind: HISTORY_SOURCE.geometry_kind,
      source: HISTORY_SOURCE.provider,
      source_url: FIRMS_MAP_URL,
      centroid: [round5(Number(row.lng)), round5(Number(row.lat))],
      restoration_updates: [] as never[],
      campaigns: [] as never[],
    },
  };
}

/** The response: a FeatureCollection with the range and provenance as foreign members. */
export function toHistoryCollection(
  rows: HistoryRow[],
  range: { from: string; to: string },
  dataAvailableFrom: string | null
) {
  return {
    type: 'FeatureCollection' as const,
    features: rows.map(toHistoryFeature).filter((f) => f.geometry !== null),
    metadata: {
      from: range.from,
      to: range.to,
      time_zone: HISTORY_TIME_ZONE,
      min_detection_count: HISTORY_MIN_DETECTIONS,
      fixed_heat_sources_excluded: true,
      data_available_from: dataAvailableFrom,
      source: HISTORY_SOURCE,
    },
  };
}
