/**
 * The rules for device and reporter locations held on the server. The
 * privacy policy (routes/legal.ts) promises exactly what this file enforces,
 * so change both together.
 *
 * - Stored coordinates are rounded to 2 decimal places: about 1.1 km
 *   north-south and 0.85-0.9 km east-west at Türkiye's latitudes. The
 *   exact fix a request carries may be used for that request (for example
 *   to resolve the nearest province), but only the rounded value is written.
 *   Measured on the live table on 2026-11-07: rounding moved the 18 stored
 *   device locations by 430 m on average and 583 m at most, and changed
 *   neither the regions within the 400 km risk-alert radius nor the
 *   nearest province for any of them.
 * - A device's location is erased when it turns notifications off, when
 *   FCM reports its token invalid, or when the user deletes it from the
 *   app.
 * - Device rows and fire reports untouched for RETENTION_DAYS are deleted
 *   (jobs/privacyRetentionJob.ts).
 * - Coordinates never reach the request log (redactLocationInUrl).
 */

export const STORED_COORDINATE_DECIMALS = 2;

export const RETENTION_DAYS = 90;

const SCALE = 10 ** STORED_COORDINATE_DECIMALS;

/**
 * Rounds a coordinate to the precision the server is allowed to keep.
 * Null in, null out, so optional request fields pass straight through.
 */
export function roundStoredCoordinate(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  // A half-way value may land on either neighbour because of binary
  // floating point; at this precision that is a ~1 km cell either way.
  return Math.round(value * SCALE) / SCALE;
}

const LOCATION_QUERY_KEY = /^(lat|lng|lon|long|latitude|longitude)$/i;

/**
 * Replaces the value of every coordinate-looking query parameter with
 * "redacted", so the access log keeps the route and status but never a
 * position. GET /api/fires/nearest-city?lat=..&lng=.. is the one route that
 * carries a user's position in the URL today; anything added later is
 * covered by the key pattern.
 */
export function redactLocationInUrl(url: string | undefined): string {
  if (!url) return '-';
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;

  const path = url.slice(0, queryStart);
  const query = url.slice(queryStart + 1);
  const parts = query.split('&').map((part) => {
    const eq = part.indexOf('=');
    const rawKey = eq === -1 ? part : part.slice(0, eq);
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
    } catch {
      // Malformed escape: keep the raw key, and still test it below.
    }
    return LOCATION_QUERY_KEY.test(key) ? `${rawKey}=redacted` : part;
  });
  return `${path}?${parts.join('&')}`;
}

/**
 * FCM error codes meaning the token will never deliver again (app
 * uninstalled, data cleared, token rotated). invalid-argument is not here:
 * it is also returned for a malformed payload, which says nothing about the
 * token.
 */
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

export function isDeadTokenError(code: string | undefined | null): boolean {
  return typeof code === 'string' && DEAD_TOKEN_CODES.has(code);
}
