"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEWS_MATCH_LOOKBACK_DAYS = exports.LAND_COVER_BATCH = exports.LAND_COVER_LOOKBACK_DAYS = void 0;
exports.pendingLandCoverSql = pendingLandCoverSql;
exports.classifyPendingLandCover = classifyPendingLandCover;
exports.matchRecentNews = matchRecentNews;
exports.runIncidentEvidence = runIncidentEvidence;
const database_1 = __importDefault(require("../config/database"));
const jobRunRecorder_1 = require("../services/jobRunRecorder");
const incidentNewsMatch_1 = require("../services/incidentNewsMatch");
const landCover_1 = require("../services/landCover");
const provinces_1 = require("../services/provinces");
exports.LAND_COVER_LOOKBACK_DAYS = 30;
exports.LAND_COVER_BATCH = 80;
exports.NEWS_MATCH_LOOKBACK_DAYS = 14;
function pendingLandCoverSql() {
    return `SELECT id, ST_Y(centroid) AS lat, ST_X(centroid) AS lng
            FROM fire_incidents
           WHERE land_cover IS NULL
             AND last_detected_at > now() - make_interval(days => $1)
           ORDER BY last_detected_at DESC
           LIMIT $2`;
}
async function classifyPendingLandCover(db, sample, stats) {
    const { rows } = await db.query(pendingLandCoverSql(), [exports.LAND_COVER_LOOKBACK_DAYS, exports.LAND_COVER_BATCH]);
    for (const row of rows) {
        try {
            const shares = await sample(Number(row.lat), Number(row.lng));
            await db.query(`UPDATE fire_incidents SET land_cover = $2, land_cover_shares = $3::jsonb WHERE id = $1`, [row.id, Object.keys(shares).length === 0 ? 'unknown' : (0, landCover_1.classifyLandCover)(shares), JSON.stringify(shares)]);
            stats.classified++;
        }
        catch (error) {
            stats.failed++;
            console.error('land cover lookup failed:', error.message);
        }
    }
}
async function matchRecentNews(db, stats) {
    const [incidents, news, cities, districts] = await Promise.all([
        db.query(`SELECT i.id, c.name AS city, ST_Y(i.centroid) AS lat, ST_X(i.centroid) AS lng,
              i.first_detected_at, i.last_detected_at
         FROM fire_incidents i
         JOIN turkey_cities c ON c.id = i.city_id
        WHERE i.news_verified_id IS NULL
          AND i.last_detected_at > now() - make_interval(days => $1)`, [exports.NEWS_MATCH_LOOKBACK_DAYS]),
        db.query(`SELECT id, title, summary, COALESCE(published_at, created_at) AS at
         FROM news
        WHERE COALESCE(published_at, created_at) > now() - make_interval(days => $1)`, [exports.NEWS_MATCH_LOOKBACK_DAYS + 1]),
        db.query(`SELECT name FROM turkey_cities`),
        db.query(`SELECT id, name, province_id, province_name, ST_Y(location) AS lat, ST_X(location) AS lng
         FROM turkey_districts`),
    ]);
    const matches = (0, incidentNewsMatch_1.matchIncidentsToNews)(incidents.rows.map((r) => ({
        id: Number(r.id),
        city: r.city,
        lat: Number(r.lat),
        lng: Number(r.lng),
        firstAt: new Date(r.first_detected_at),
        lastAt: new Date(r.last_detected_at),
    })), news.rows.map((r) => ({ id: Number(r.id), title: r.title, summary: r.summary, publishedAt: new Date(r.at) })), {
        cityNames: (0, provinces_1.withFormerNames)(cities.rows.map((r) => String(r.name))),
        districts: districts.rows.map((r) => ({
            id: Number(r.id),
            name: String(r.name),
            provinceId: Number(r.province_id),
            provinceName: String(r.province_name),
            lat: Number(r.lat),
            lng: Number(r.lng),
        })),
    });
    for (const [incident, article] of matches) {
        await db.query(`UPDATE fire_incidents SET news_verified_id = $2 WHERE id = $1 AND news_verified_id IS NULL`, [
            incident,
            article,
        ]);
        stats.matched++;
    }
}
async function runIncidentEvidence(db, sample) {
    const stats = { classified: 0, failed: 0, matched: 0 };
    await classifyPendingLandCover(db, sample, stats);
    await matchRecentNews(db, stats);
    return stats;
}
class IncidentEvidenceJob {
    async run() {
        const startedAt = new Date();
        try {
            const stats = await runIncidentEvidence(database_1.default, landCover_1.sampleWorldCover);
            await (0, jobRunRecorder_1.recordJobRun)('incident_evidence', startedAt, 'ok', { ...stats });
        }
        catch (error) {
            console.error('incident evidence failed:', error.message);
        }
    }
}
exports.default = new IncidentEvidenceJob();
