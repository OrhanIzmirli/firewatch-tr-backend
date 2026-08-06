import * as satellite from 'satellite.js';

/**
 * Was a location scanned by a polar orbiter, from orbital elements alone.
 *
 * WHY: FIRMS reports detections and nothing else — it never says "I looked
 * here and saw nothing". Counting passes from detections therefore gives a
 * structural LOWER BOUND: a pass that crossed Turkey and found nothing is
 * invisible. Tolerable in fire season, close to useless in winter.
 *
 * WHAT THIS IS NOT: this answers "was it scanned", never "was there a fire".
 * Cloud, smoke and the much higher detection threshold at scan edge all
 * remain. The strongest claim it supports is "the satellite looked here".
 * satellite_state keeps its two-value CHECK constraint and 'extinguished'
 * still requires an official source.
 *
 * COST: deliberately geometry-free. Whether a point sits in the swath is a
 * DISTANCE question, not a polygon question — the perpendicular distance from
 * the point to the sub-satellite ground track, compared against the half
 * swath. No polygons are built, nothing is written to PostGIS, no table is
 * added. The track is computed in memory and thrown away, which matters on a
 * 0.1-CPU 512 MB free instance.
 */

const EARTH_RADIUS_KM = 6371.0088;

export interface Sensor {
  name: string;
  tleName: string;
  product: string;
  /**
   * Value(s) in the FIRMS `satellite` column for this platform. Verified
   * against live responses rather than assumed: SNPP reports 'N', the JPSS
   * pair report 'N20'/'N21', and MODIS_NRT mixes both of its platforms in one
   * product, tagged 'Terra' and 'Aqua'.
   */
  firmsSatelliteCodes: string[];
  /** Cross-track scan half-angle in degrees. */
  scanAngleDeg: number;
}

/**
 * Scan limits: VIIRS +/-56.28 deg at ~830 km gives a ~3040 km swath, MODIS
 * +/-55 deg at ~705 km gives ~2330 km. Both match the published figures.
 */
export const SENSORS: Sensor[] = [
  { name: 'Suomi NPP', tleName: 'SUOMI NPP', product: 'VIIRS_SNPP_NRT', firmsSatelliteCodes: ['N'], scanAngleDeg: 56.28 },
  { name: 'NOAA-20', tleName: 'NOAA 20 (JPSS-1)', product: 'VIIRS_NOAA20_NRT', firmsSatelliteCodes: ['N20'], scanAngleDeg: 56.28 },
  { name: 'NOAA-21', tleName: 'NOAA 21 (JPSS-2)', product: 'VIIRS_NOAA21_NRT', firmsSatelliteCodes: ['N21'], scanAngleDeg: 56.28 },
  { name: 'Terra', tleName: 'TERRA', product: 'MODIS_NRT', firmsSatelliteCodes: ['Terra'], scanAngleDeg: 55 },
  { name: 'Aqua', tleName: 'AQUA', product: 'MODIS_NRT', firmsSatelliteCodes: ['Aqua'], scanAngleDeg: 55 },
];

/**
 * Beyond this fraction of the half swath the evidence is weak.
 *
 * A VIIRS I-band pixel grows from 375 m at nadir to roughly 800 m at the scan
 * edge, so the same fire has to be far more intense to trigger a detection out
 * there. Coverage past this line is recorded separately and must never be
 * presented with the same confidence as a nadir look.
 */
export const NADIR_FRACTION_LIMIT = 0.6;

export interface TrackPoint {
  time: Date;
  latDeg: number;
  lonDeg: number;
  altKm: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/**
 * Ground half-swath for a cross-track scanner.
 *
 * A look angle theta from nadir at altitude h subtends an Earth-central angle
 * gamma = asin(((R+h)/R) sin theta) - theta, ground distance R * gamma.
 * Derived from the propagated altitude rather than hard-coded, so it stays
 * correct as the orbit changes.
 */
export function halfSwathKm(altKm: number, scanAngleDeg: number): number {
  const theta = toRad(scanAngleDeg);
  const ratio = (EARTH_RADIUS_KM + altKm) / EARTH_RADIUS_KM;
  const sinArg = Math.min(1, ratio * Math.sin(theta));
  return EARTH_RADIUS_KM * (Math.asin(sinArg) - theta);
}

export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const phi1 = toRad(aLat), phi2 = toRad(bLat);
  const dPhi = toRad(bLat - aLat), dLambda = toRad(bLon - aLon);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearingRad(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const phi1 = toRad(aLat), phi2 = toRad(bLat);
  const dLambda = toRad(bLon - aLon);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return Math.atan2(y, x);
}

/**
 * Perpendicular (cross-track) distance from a point to the great-circle
 * segment a-b, in km. Falls back to the nearer endpoint when the point
 * projects outside the segment, so sampling the track coarsely cannot produce
 * a spuriously small distance.
 */
export function crossTrackDistanceKm(
  aLat: number, aLon: number,
  bLat: number, bLon: number,
  pLat: number, pLon: number
): number {
  const d13 = distanceKm(aLat, aLon, pLat, pLon) / EARTH_RADIUS_KM;
  const theta13 = bearingRad(aLat, aLon, pLat, pLon);
  const theta12 = bearingRad(aLat, aLon, bLat, bLon);

  const dxt = Math.asin(Math.sin(d13) * Math.sin(theta13 - theta12));
  // Along-track position of the projection.
  const dat = Math.acos(Math.min(1, Math.max(-1, Math.cos(d13) / Math.cos(dxt))));
  const segment = distanceKm(aLat, aLon, bLat, bLon) / EARTH_RADIUS_KM;

  if (dat < 0 || Number.isNaN(dat)) return distanceKm(aLat, aLon, pLat, pLon);
  if (dat > segment) return distanceKm(bLat, bLon, pLat, pLon);
  return Math.abs(dxt) * EARTH_RADIUS_KM;
}

export function parseTle(text: string, objectName: string): satellite.SatRec | null {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i].trim() === objectName.trim()) {
      return satellite.twoline2satrec(lines[i + 1], lines[i + 2]);
    }
  }
  for (let i = 0; i < lines.length - 2; i++) {
    if (lines[i + 1]?.startsWith('1 ') && lines[i + 2]?.startsWith('2 ')) {
      return satellite.twoline2satrec(lines[i + 1], lines[i + 2]);
    }
  }
  return null;
}

/**
 * Sub-satellite ground track.
 *
 * STEP CHOICE: these orbiters move about 7.5 km/s along track, so a 60 s step
 * puts vertices ~450 km apart. That is fine here only because coverage is
 * measured against the SEGMENT between vertices, not the vertices themselves —
 * the great-circle segment deviates from the true track by well under a
 * kilometre over that span, negligible against a 1500 km half swath. 30 s is
 * used by default because it costs almost nothing and halves that error.
 */
export function groundTrack(
  satrec: satellite.SatRec,
  start: Date,
  end: Date,
  stepSeconds: number
): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += stepSeconds * 1000) {
    const time = new Date(t);
    const pv = satellite.propagate(satrec, time);
    if (!pv || typeof pv.position === 'boolean' || !pv.position) continue;
    const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(time));
    points.push({
      time,
      latDeg: satellite.degreesLat(geo.latitude),
      lonDeg: satellite.degreesLong(geo.longitude),
      altKm: geo.height,
    });
  }
  return points;
}

export interface CoverageResult {
  covered: boolean;
  /** 0 at nadir, 1 at the scan edge. */
  fraction: number;
  crossTrackKm: number;
  halfSwathKm: number;
  nearNadir: boolean;
  /** Time of the closest approach — when the location was scanned. */
  at: Date | null;
}

const NOT_COVERED: CoverageResult = {
  covered: false, fraction: Number.POSITIVE_INFINITY, crossTrackKm: Number.POSITIVE_INFINITY,
  halfSwathKm: 0, nearNadir: false, at: null,
};

/**
 * Whether a location fell inside the swath during a track window.
 *
 * Walks the track segments and keeps the smallest cross-track distance. No
 * polygon is constructed at any point.
 */
export function coverageForPoint(
  track: TrackPoint[],
  latDeg: number,
  lonDeg: number,
  scanAngleDeg: number
): CoverageResult {
  if (track.length < 2) return NOT_COVERED;

  let best = Number.POSITIVE_INFINITY;
  let bestHalf = 0;
  let bestAt: Date | null = null;

  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    // Cheap reject: if the segment start is more than a swath plus a segment
    // length away, the perpendicular cannot be closer.
    const rough = distanceKm(a.latDeg, a.lonDeg, latDeg, lonDeg);
    if (rough > 3000) continue;

    const d = crossTrackDistanceKm(a.latDeg, a.lonDeg, b.latDeg, b.lonDeg, latDeg, lonDeg);
    if (d < best) {
      best = d;
      bestHalf = halfSwathKm(a.altKm, scanAngleDeg);
      bestAt = a.time;
    }
  }

  if (!Number.isFinite(best) || bestHalf === 0) return NOT_COVERED;

  const fraction = best / bestHalf;
  return {
    covered: fraction <= 1,
    fraction,
    crossTrackKm: best,
    halfSwathKm: bestHalf,
    nearNadir: fraction <= NADIR_FRACTION_LIMIT,
    at: bestAt,
  };
}
