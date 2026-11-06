"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEARBY_FIRE_PIPELINE_JOBS = exports.NEARBY_FIRE_MAX_STALENESS_HOURS = exports.NEARBY_FIRE_WINDOW_HOURS = void 0;
exports.isPipelineFresh = isPipelineFresh;
exports.attachNearbyFireCounts = attachNearbyFireCounts;
exports.nearbyFireCountSql = nearbyFireCountSql;
exports.loadNearbyFireCounts = loadNearbyFireCounts;
const heatSource_1 = require("./heatSource");
const regions_1 = require("../utils/regions");
/**
 * `nearby_fire_count` for GET /api/risk/summary: how many satellite fire
 * incidents were detected in the same region during the last 24 hours,
 * fixed heat sources (steelworks, refineries, flares) excluded.
 *
 * "Missing means unavailable, never zero" (app contract). So the count is
 * null — for every region at once — whenever the satellite pipeline cannot
 * vouch for the last few hours: the ingest or cluster job has not finished
 * successfully within NEARBY_FIRE_MAX_STALENESS_HOURS, job_runs is missing,
 * or the count query fails. A region the pipeline covers but where nothing
 * was detected is a real 0.
 *
 * Heat sources are excluded with the SQL form of the rule
 * (heatSourceSqlCondition) rather than the heat_source_class column, so the
 * count is right whether or not migration 011 has been applied.
 */
exports.NEARBY_FIRE_WINDOW_HOURS = 24;
/** Chosen 2026-11-06: with real ingest gaps this is null ~17% of the time. */
exports.NEARBY_FIRE_MAX_STALENESS_HOURS = 6;
/** Both must be fresh: ingest fetches the pixels, cluster turns them into incidents. */
exports.NEARBY_FIRE_PIPELINE_JOBS = ['ingest', 'cluster'];
/** True when every pipeline job has a successful run recent enough. */
function isPipelineFresh(lastOk, now, maxStalenessHours = exports.NEARBY_FIRE_MAX_STALENESS_HOURS) {
    const limitMs = maxStalenessHours * 3600000;
    return exports.NEARBY_FIRE_PIPELINE_JOBS.every((job) => {
        const at = lastOk[job];
        if (!at || Number.isNaN(at.getTime()))
            return false;
        const age = now.getTime() - at.getTime();
        return age >= 0 && age <= limitMs;
    });
}
/**
 * Adds nearby_fire_count to each risk row. `counts` null → every row null;
 * a row whose region name is not a known region → null; otherwise the count
 * for its region, 0 when none.
 */
function attachNearbyFireCounts(rows, counts) {
    return rows.map((row) => {
        const key = (0, regions_1.regionKeyForRegionName)(row.region);
        const count = counts && key ? counts.get(key) ?? 0 : null;
        return { ...row, nearby_fire_count: count };
    });
}
/** SQL for the per-region count; exported so the test can pin its shape. */
function nearbyFireCountSql() {
    return `SELECT i.region_key, count(*)::int AS n
            FROM fire_incidents i
           WHERE i.last_detected_at > now() - make_interval(hours => $1)
             AND i.region_key IS NOT NULL
             AND NOT COALESCE((${(0, heatSource_1.heatSourceSqlCondition)('i')}), false)
           GROUP BY i.region_key`;
}
/** Per-region counts, or null when the pipeline is stale or unreadable. */
async function loadNearbyFireCounts(db) {
    try {
        // "now" comes from the database, the same clock that stamped
        // finished_at, so server/DB clock skew cannot make a fresh run look
        // like it finished in the future.
        const runs = await db.query(`SELECT j.job, now() AS db_now,
              (SELECT max(r.finished_at) FROM job_runs r
                WHERE r.job = j.job AND r.status = 'ok') AS last_ok
         FROM unnest($1::text[]) AS j(job)`, [[...exports.NEARBY_FIRE_PIPELINE_JOBS]]);
        if (runs.rows.length === 0)
            return null;
        const now = new Date(runs.rows[0].db_now);
        const lastOk = {};
        for (const r of runs.rows)
            lastOk[r.job] = r.last_ok ? new Date(r.last_ok) : null;
        if (!isPipelineFresh(lastOk, now))
            return null;
        const result = await db.query(nearbyFireCountSql(), [exports.NEARBY_FIRE_WINDOW_HOURS]);
        const counts = new Map();
        for (const r of result.rows)
            counts.set(r.region_key, Number(r.n));
        return counts;
    }
    catch (error) {
        console.error('nearby_fire_count unavailable:', error.message);
        return null;
    }
}
