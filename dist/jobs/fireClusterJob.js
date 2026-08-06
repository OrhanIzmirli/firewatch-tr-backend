"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const database_1 = __importDefault(require("../config/database"));
/**
 * Turns raw FIRMS pixels into fire incidents.
 *
 * A satellite does not report "a fire"; it reports hot pixels, several per
 * fire per overpass, at slightly different positions each pass. Duration,
 * "is it still being detected" and spread only exist once those pixels are
 * grouped into something that persists across passes — that grouping is this
 * job.
 *
 * SAFETY: nothing here may ever conclude that a fire is out. The satellite
 * axis can only say 'detected_recently' or 'no_recent_detection', and the
 * database CHECK constraint on satellite_state makes any other value
 * impossible. official_state is never written from this file.
 */
/**
 * DBSCAN neighbourhood radius, in METRES.
 *
 * Clustering runs on EPSG:3035 (ETRS89 Lambert azimuthal equal-area), not on
 * raw degrees. Measured across Turkey, a true 1200 m separation comes out as
 * 1194-1205 m in 3035 (<0.5% error) but as 0.0108-0.0141 degrees depending on
 * latitude and bearing — a 30% spread that would make the same eps mean
 * different things in Hatay and in Edirne.
 *
 * 1200 m sits above the 375 m VIIRS and ~1 km MODIS pixel pitch, so adjacent
 * pixels of one fire front join up, while genuinely separate fires a couple
 * of kilometres apart stay separate.
 */
const CLUSTER_EPS_METRES = 1200;
/**
 * minPoints = 1 is deliberate and is a safety decision, not a tuning one.
 * With minPoints > 1 DBSCAN labels lone points as noise and discards them —
 * and a lone hot pixel is exactly what a fire looks like in its first
 * overpass. Nothing may be dropped for being small.
 */
const CLUSTER_MIN_POINTS = 1;
/** Only detections from this window are considered for new clustering. */
const CLUSTER_WINDOW_HOURS = 24;
/** An incident stays open for matching this long after its last detection. */
const INCIDENT_MATCH_HOURS = 72;
/** A new cluster joins an open incident if it lands within this distance. */
const INCIDENT_MATCH_METRES = 2000;
/** Below this age the satellite axis reads 'detected_recently'. */
const RECENT_DETECTION_HOURS = 6;
/** Spread is only computed with at least this much evidence. */
const SPREAD_MIN_OVERPASSES = 2;
const SPREAD_MIN_DETECTIONS = 4;
/** Above these it is upgraded from 'low' to 'moderate'. */
const SPREAD_MODERATE_OVERPASSES = 4;
const SPREAD_MODERATE_DETECTIONS = 10;
/**
 * Distinct SATELLITE PASSES represented by a set of acquisition timestamps.
 *
 * FIRMS stamps each granule separately, so one sweep over a large fire arrives
 * as several timestamps a minute or two apart. Measured on a real Turkish day,
 * six distinct acq_time values were only three actual passes (00:03/00:05,
 * 09:43/09:45, 11:25/11:28) — counting raw distinct timestamps doubles the
 * pass count, and both the spread gate and every "seen in N passes" statement
 * depend on that number.
 *
 * Timestamps closer together than this fold into one pass. Separate platforms
 * are much further apart (SNPP and NOAA-20 are about 50 minutes apart), so two
 * satellites observing the same fire still count as two passes, while two
 * granules of a single sweep count as one.
 */
const PASS_GAP_MINUTES = 10;
/**
 * SQL counting passes in a timestamptz[] by folding near-adjacent times.
 * Inlined rather than added as a database function so no extra migration is
 * needed against a schema that is already live.
 */
function passCountSql(arrayExpr) {
    return `(
    SELECT count(*)::int FROM (
      SELECT t, lag(t) OVER (ORDER BY t) AS prev
      FROM unnest(${arrayExpr}) AS t
    ) g
    WHERE g.prev IS NULL OR g.t - g.prev > INTERVAL '${PASS_GAP_MINUTES} minutes'
  )`;
}
class FireClusterJob {
    constructor() {
        /**
         * Whether migration 004 has been applied. The persistence metrics are
         * written only when their columns exist, so a server that is ahead of the
         * database keeps clustering correctly instead of failing on every insert.
         * Checked once per run, not per row.
         */
        this.persistenceColumns = null;
    }
    async hasPersistenceColumns() {
        if (this.persistenceColumns !== null)
            return this.persistenceColumns;
        try {
            const result = await database_1.default.query(`SELECT count(*)::int AS n
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'fire_incidents'
            AND column_name IN ('seen_days', 'distinct_days_seen',
                                'frp_sum', 'frp_sum_sq', 'frp_sample_count')`);
            this.persistenceColumns = Number(result.rows[0]?.n ?? 0) === 5;
        }
        catch {
            this.persistenceColumns = false;
        }
        if (!this.persistenceColumns) {
            console.log('ℹ️  persistence metrics not stored — apply ' +
                'database/migrations/004_add_incident_persistence_metrics.sql');
        }
        return this.persistenceColumns;
    }
    async tablesExist() {
        const result = await database_1.default.query(`SELECT to_regclass('public.fire_incidents')  AS incidents,
              to_regclass('public.fire_detections') AS detections`);
        const row = result.rows[0];
        return row?.incidents !== null && row?.detections !== null;
    }
    async runClustering() {
        const stats = {
            skipped: false,
            unclusteredConsidered: 0,
            clustersFormed: 0,
            incidentsCreated: 0,
            incidentsExtended: 0,
            detectionsLinked: 0,
            spreadComputed: 0,
            statesRefreshed: 0,
        };
        if (!(await this.tablesExist())) {
            stats.skipped = true;
            console.log('⏭️  fire_incidents missing — skipping clustering. ' +
                'Apply database/migrations/003_add_fire_incidents.sql first.');
            return stats;
        }
        const client = await database_1.default.connect();
        try {
            await client.query('BEGIN');
            const clusters = await this.buildClusters(client);
            stats.unclusteredConsidered = clusters.reduce((n, c) => n + c.detectionIds.length, 0);
            stats.clustersFormed = clusters.length;
            for (const cluster of clusters) {
                const existingId = await this.findOpenIncident(client, cluster);
                if (existingId === null) {
                    await this.createIncident(client, cluster);
                    stats.incidentsCreated++;
                }
                else {
                    await this.extendIncident(client, existingId, cluster);
                    stats.incidentsExtended++;
                }
                stats.detectionsLinked += cluster.detectionIds.length;
            }
            stats.spreadComputed = await this.refreshSpread(client);
            stats.statesRefreshed = await this.refreshSatelliteState(client);
            await client.query('COMMIT');
            console.log(`🔥 Clustering: ${stats.unclusteredConsidered} detections -> ` +
                `${stats.clustersFormed} clusters (${stats.incidentsCreated} new incidents, ` +
                `${stats.incidentsExtended} extended), spread computed for ` +
                `${stats.spreadComputed}, states refreshed ${stats.statesRefreshed}`);
            return stats;
        }
        catch (error) {
            await client.query('ROLLBACK');
            console.error('❌ Clustering failed:', error.message);
            return stats;
        }
        finally {
            client.release();
        }
    }
    /**
     * DBSCAN over the detections not yet attached to an incident.
     *
     * Only unattached rows are clustered, which keeps each run incremental and
     * idempotent: already-linked pixels are never regrouped, and a fire that
     * keeps burning is joined to its existing incident by the proximity match
     * rather than by re-clustering its whole history every 30 minutes.
     */
    async buildClusters(client) {
        const result = await client.query(`WITH windowed AS (
         SELECT id, geom, acquired_at, frp_mw, confidence_tier, city_id, region_key
         FROM fire_detections
         WHERE incident_id IS NULL
           AND acquired_at > NOW() - INTERVAL '${CLUSTER_WINDOW_HOURS} hours'
       ),
       clustered AS (
         SELECT *,
                ST_ClusterDBSCAN(ST_Transform(geom, 3035), $1, $2)
                  OVER () AS cluster_idx
         FROM windowed
       )
       SELECT cluster_idx,
              array_agg(id ORDER BY acquired_at)          AS detection_ids,
              min(acquired_at)                            AS first_detected_at,
              max(acquired_at)                            AS last_detected_at,
              count(*)::int                               AS detection_count,
              array_agg(DISTINCT acquired_at)             AS overpass_times,
              ST_AsText(ST_Multi(ST_Collect(geom)))       AS footprint_wkt,
              ST_AsText(ST_Centroid(ST_Collect(geom)))    AS centroid_wkt,
              max(frp_mw)                                 AS max_frp_mw,
              -- Accumulators, not statistics: a mean cannot be folded into
              -- another mean without its weight, and this job folds.
              COALESCE(sum(frp_mw), 0)                    AS frp_sum,
              COALESCE(sum(frp_mw * frp_mw), 0)           AS frp_sum_sq,
              count(frp_mw)::int                          AS frp_sample_count,
              -- The UTC dates this cluster was seen on. Stored as a set so
              -- re-processing the same detection cannot inflate the count.
              ARRAY(SELECT DISTINCT (acquired_at AT TIME ZONE 'UTC')::date
                    ORDER BY 1)                           AS seen_days,
              (array_agg(confidence_tier ORDER BY
                 CASE confidence_tier WHEN 'high' THEN 0 WHEN 'nominal' THEN 1 ELSE 2 END
               ))[1]                                      AS peak_confidence_tier,
              mode() WITHIN GROUP (ORDER BY city_id)      AS city_id,
              mode() WITHIN GROUP (ORDER BY region_key)   AS region_key
       FROM clustered
       WHERE cluster_idx IS NOT NULL
       GROUP BY cluster_idx`, [CLUSTER_EPS_METRES, CLUSTER_MIN_POINTS]);
        return result.rows.map((row) => ({
            detectionIds: row.detection_ids,
            firstDetectedAt: row.first_detected_at,
            lastDetectedAt: row.last_detected_at,
            detectionCount: row.detection_count,
            overpassTimes: row.overpass_times,
            footprintWkt: row.footprint_wkt,
            centroidWkt: row.centroid_wkt,
            maxFrpMw: row.max_frp_mw === null ? null : Number(row.max_frp_mw),
            frpSum: Number(row.frp_sum ?? 0),
            frpSumSq: Number(row.frp_sum_sq ?? 0),
            frpSampleCount: Number(row.frp_sample_count ?? 0),
            seenDays: (row.seen_days ?? []),
            peakConfidenceTier: row.peak_confidence_tier,
            cityId: row.city_id === null ? null : Number(row.city_id),
            regionKey: row.region_key,
        }));
    }
    /**
     * Finds an incident this cluster belongs to: still recent, not officially
     * closed, and with a footprint within the match radius. Matching on the
     * footprint rather than the centroid means a long fire front is still
     * recognised when new pixels appear at its far end.
     */
    async findOpenIncident(client, cluster) {
        const result = await client.query(`SELECT id
       FROM fire_incidents
       WHERE last_detected_at > NOW() - INTERVAL '${INCIDENT_MATCH_HOURS} hours'
         AND official_state IS DISTINCT FROM 'extinguished'
         AND ST_DWithin(
               footprint::geography,
               ST_GeomFromText($1, 4326)::geography,
               $2
             )
       ORDER BY ST_Distance(footprint::geography, ST_GeomFromText($1, 4326)::geography)
       LIMIT 1`, [cluster.footprintWkt, INCIDENT_MATCH_METRES]);
        return result.rows[0] ? Number(result.rows[0].id) : null;
    }
    async createIncident(client, cluster) {
        const persistence = await this.hasPersistenceColumns();
        const extraColumns = persistence
            ? ', seen_days, distinct_days_seen, frp_sum, frp_sum_sq, frp_sample_count'
            : '';
        const extraValues = persistence
            ? `, $11::date[], COALESCE(array_length($11::date[], 1), 0), $12, $13, $14`
            : '';
        const params = [
            cluster.firstDetectedAt,
            cluster.lastDetectedAt,
            cluster.detectionCount,
            cluster.overpassTimes,
            cluster.centroidWkt,
            cluster.footprintWkt,
            cluster.maxFrpMw,
            cluster.peakConfidenceTier,
            cluster.cityId,
            cluster.regionKey,
        ];
        if (persistence) {
            params.push(cluster.seenDays, cluster.frpSum, cluster.frpSumSq, cluster.frpSampleCount);
        }
        const result = await client.query(`INSERT INTO fire_incidents (
         first_detected_at, last_detected_at, detection_count,
         overpass_times, overpass_count,
         centroid, footprint, max_frp_mw, peak_confidence_tier,
         city_id, region_key,
         satellite_state, hours_since_last_detection${extraColumns}
       ) VALUES (
         $1, $2, $3, $4::timestamptz[], COALESCE(${passCountSql('$4::timestamptz[]')}, 0),
         ST_GeomFromText($5, 4326), ST_Multi(ST_GeomFromText($6, 4326)),
         $7, $8, $9, $10,
         CASE WHEN $2::timestamptz > NOW() - INTERVAL '${RECENT_DETECTION_HOURS} hours'
              THEN 'detected_recently' ELSE 'no_recent_detection' END,
         GREATEST(EXTRACT(EPOCH FROM (NOW() - $2::timestamptz)) / 3600.0, 0)${extraValues}
       )
       RETURNING id`, params);
        await this.linkDetections(client, Number(result.rows[0].id), cluster.detectionIds);
    }
    /**
     * Merges a cluster into an existing incident.
     *
     * Every aggregate is folded into the stored value rather than recomputed
     * from fire_detections. That is what makes the 90-day detection prune safe:
     * once raw pixels are deleted, an incident's footprint, counts and dates
     * still describe everything it ever saw.
     */
    async extendIncident(client, incidentId, cluster) {
        const persistence = await this.hasPersistenceColumns();
        // Days fold as a SET UNION, not an addition. The incident match rule
        // (72 h, 2 km) deliberately extends the same incident run after run, so
        // an additive counter would climb every time the job re-saw the same day.
        // Unioning dates is idempotent: seeing 2026-08-06 for the fifth time
        // leaves the array, and therefore the counter, unchanged. The FRP
        // accumulators DO add, and that is correct — they are weighted by sample
        // count, and each detection is linked exactly once (linkDetections sets
        // incident_id, and the cluster query only reads rows where it is NULL).
        const persistenceSet = persistence
            ? `,
         seen_days = sub.days,
         distinct_days_seen = COALESCE(array_length(sub.days, 1), 0),
         frp_sum = frp_sum + $11::numeric,
         frp_sum_sq = frp_sum_sq + $12::numeric,
         frp_sample_count = frp_sample_count + $13`
            : '';
        const persistenceSub = persistence
            ? `,
           ARRAY(
             SELECT DISTINCT unnest(fi2.seen_days || $14::date[])
             ORDER BY 1
           ) AS days`
            : '';
        const params = [
            incidentId,
            cluster.firstDetectedAt,
            cluster.lastDetectedAt,
            cluster.detectionCount,
            cluster.overpassTimes,
            cluster.footprintWkt,
            cluster.maxFrpMw,
            cluster.peakConfidenceTier,
            cluster.cityId,
            cluster.regionKey,
        ];
        if (persistence) {
            params.push(cluster.frpSum, cluster.frpSumSq, cluster.frpSampleCount, cluster.seenDays);
        }
        await client.query(`UPDATE fire_incidents SET
         first_detected_at = LEAST(first_detected_at, $2::timestamptz),
         last_detected_at  = GREATEST(last_detected_at, $3::timestamptz),
         detection_count   = detection_count + $4,
         overpass_times    = sub.times,
         overpass_count    = COALESCE(${passCountSql('sub.times')}, 0),
         footprint         = ST_Multi(ST_Union(footprint, ST_GeomFromText($6, 4326))),
         centroid          = ST_Centroid(ST_Union(footprint, ST_GeomFromText($6, 4326))),
         max_frp_mw        = GREATEST(COALESCE(max_frp_mw, 0), COALESCE($7::numeric, 0)),
         peak_confidence_tier = CASE
             WHEN peak_confidence_tier = 'high' OR $8 = 'high' THEN 'high'
             WHEN peak_confidence_tier = 'nominal' OR $8 = 'nominal' THEN 'nominal'
             ELSE COALESCE(peak_confidence_tier, $8)
           END,
         city_id    = COALESCE(city_id, $9),
         region_key = COALESCE(region_key, $10),
         updated_at = NOW()${persistenceSet}
       FROM (
         SELECT ARRAY(
           SELECT DISTINCT unnest(fi2.overpass_times || $5::timestamptz[])
           ORDER BY 1
         ) AS times${persistenceSub}
         FROM fire_incidents fi2 WHERE fi2.id = $1
       ) sub
       WHERE id = $1`, params);
        await this.linkDetections(client, incidentId, cluster.detectionIds);
    }
    async linkDetections(client, incidentId, ids) {
        await client.query(`UPDATE fire_detections SET incident_id = $1 WHERE id = ANY($2::bigint[])`, [incidentId, ids]);
    }
    /**
     * Direction and rate of travel, from the centroid of the earlier half of an
     * incident's detections to the centroid of the later half.
     *
     * This measures how the DETECTION PATTERN moved, which is not the same as
     * how the fire moved: view angle alone shifts pixel centres between passes.
     * That is why the result is published with a confidence of at most
     * 'moderate', and why nothing is published at all below two overpasses and
     * four detections — the CHECK constraint then forces both values to stay
     * NULL rather than showing a made-up bearing.
     *
     * Incidents whose detections have been pruned simply fail the minimum and
     * keep whatever was last computed; they are never reset to null.
     */
    async refreshSpread(client) {
        const result = await client.query(`WITH halves AS (
         SELECT d.incident_id,
                count(*)::int AS n,
                array_agg(DISTINCT d.acquired_at) AS times,
                ST_Centroid(ST_Collect(d.geom) FILTER (
                  WHERE d.acquired_at <= mid.mid_time)) AS c1,
                ST_Centroid(ST_Collect(d.geom) FILTER (
                  WHERE d.acquired_at >  mid.mid_time)) AS c2,
                avg(EXTRACT(EPOCH FROM d.acquired_at)) FILTER (
                  WHERE d.acquired_at <= mid.mid_time) AS t1,
                avg(EXTRACT(EPOCH FROM d.acquired_at)) FILTER (
                  WHERE d.acquired_at >  mid.mid_time) AS t2
         FROM fire_detections d
         JOIN LATERAL (
           SELECT to_timestamp(
                    (EXTRACT(EPOCH FROM min(x.acquired_at)) +
                     EXTRACT(EPOCH FROM max(x.acquired_at))) / 2
                  ) AS mid_time
           FROM fire_detections x WHERE x.incident_id = d.incident_id
         ) mid ON true
         WHERE d.incident_id IS NOT NULL
         GROUP BY d.incident_id
       ),
       usable AS (
         SELECT incident_id, n, ${passCountSql('times')} AS overpasses, c1, c2, t1, t2
         FROM halves
         WHERE ${passCountSql('times')} >= $1 AND n >= $2
           AND c1 IS NOT NULL AND c2 IS NOT NULL
           AND t2 > t1
       )
       UPDATE fire_incidents fi SET
         spread_bearing_deg = round(degrees(ST_Azimuth(u.c1, u.c2))::numeric, 2),
         spread_speed_mh    = round(
             (ST_Distance(u.c1::geography, u.c2::geography) /
              ((u.t2 - u.t1) / 3600.0))::numeric, 2),
         spread_confidence  = CASE
             WHEN u.overpasses >= $3 AND u.n >= $4 THEN 'moderate' ELSE 'low' END,
         updated_at = NOW()
       FROM usable u
       WHERE fi.id = u.incident_id`, [
            SPREAD_MIN_OVERPASSES,
            SPREAD_MIN_DETECTIONS,
            SPREAD_MODERATE_OVERPASSES,
            SPREAD_MODERATE_DETECTIONS,
        ]);
        return result.rowCount ?? 0;
    }
    /**
     * Recomputes the time-dependent satellite axis for every incident.
     *
     * This has to sweep the whole table, not just the ones touched this run:
     * an incident becomes 'no_recent_detection' precisely by NOT being seen, so
     * nothing about it changes to trigger an update.
     *
     * Note what this can and cannot say. 'no_recent_detection' means the
     * satellite has not reported this location for a while — which may mean the
     * fire is out, or that it is under cloud, under smoke, or simply that no
     * overpass has happened. It is never evidence of extinction, and the CHECK
     * constraint on this column makes 'extinguished' unrepresentable here.
     */
    async refreshSatelliteState(client) {
        const result = await client.query(`UPDATE fire_incidents SET
         hours_since_last_detection =
           GREATEST(EXTRACT(EPOCH FROM (NOW() - last_detected_at)) / 3600.0, 0),
         satellite_state = CASE
           WHEN last_detected_at > NOW() - INTERVAL '${RECENT_DETECTION_HOURS} hours'
             THEN 'detected_recently'
           ELSE 'no_recent_detection'
         END,
         updated_at = NOW()`);
        return result.rowCount ?? 0;
    }
}
exports.default = new FireClusterJob();
