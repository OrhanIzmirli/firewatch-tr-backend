"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REPORT_MATCH_WINDOW_HOURS = exports.REPORT_MATCH_RADIUS_M = void 0;
exports.reportSatelliteMatchSql = reportSatelliteMatchSql;
exports.reportResultMessage = reportResultMessage;
/**
 * Does a user's fire report have a satellite heat detection near it?
 *
 * Until 2026-11-08 this counted rows in the `fires` table, which nothing
 * fills (GET /api/fires returned 0 rows), and had no time limit, so a report
 * could never match. Detections live in fire_detections. A match means only
 * that a satellite saw heat nearby recently; it does not confirm a fire.
 */
exports.REPORT_MATCH_RADIUS_M = 10000;
exports.REPORT_MATCH_WINDOW_HOURS = 24;
/** Params: $1 lng, $2 lat, $3 radius (m), $4 window (hours). */
function reportSatelliteMatchSql() {
    return `SELECT COUNT(*) AS count
            FROM fire_detections d
           WHERE d.acquired_at > now() - make_interval(hours => $4)
             AND ST_DWithin(
                   d.geom::geography,
                   ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                   $3
                 )`;
}
function reportResultMessage(matched) {
    return matched
        ? 'Yakında son 24 saatte uydu ısı tespiti var; bu, yangını tek başına doğrulamaz.'
        : 'Rapor alındı; yakında son 24 saatte uydu ısı tespiti bulunmadı.';
}
