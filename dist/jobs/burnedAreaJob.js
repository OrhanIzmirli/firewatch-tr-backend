"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const axios_1 = __importDefault(require("axios"));
const database_1 = __importDefault(require("../config/database"));
const jobRunRecorder_1 = require("../services/jobRunRecorder");
const appeearsClient_1 = require("../services/appeearsClient");
const burnedAreaRaster_1 = require("../services/burnedAreaRaster");
const burnedAreaSchedule_1 = require("../services/burnedAreaSchedule");
/**
 * Satellite-mapped burned area, per district, per month — from NASA's
 * MCD64A1 product through AppEEARS.
 *
 * WHAT IT WRITES
 *   burned_area_fetches   the per-month state machine below
 *   burned_pixels         every burned 500 m pixel as a point
 *   burned_area_monthly   hectares per district per month (the read model)
 *   fire_incidents.optical_*   the "AXIS 2" columns migration 003 reserved:
 *                         hectares mapped within 3 km of an incident's
 *                         footprint during its detection window
 *
 * WHAT IT NEVER WRITES
 *   fire_incidents.official_state, satellite_state, or anything that could
 *   be read as "the fire is out". A burned pixel says land burned. It does
 *   not say the fire stopped, and it does not say what the land was.
 *
 * THE STATE MACHINE, per (product, month)
 *   (no row) ─┐
 *   awaiting_granules ──CMR shows all 6 tiles──▶ submitted ──task done──▶ downloaded
 *        ▲                                          │
 *        └────────── task error / bad bundle ───── failed  (retried ≤ 3×)
 *
 * NASA publishes a month 38–50 days after it ends (measured; see migration
 * 010). Rather than guess the day, the job runs daily, asks the public CMR
 * catalogue whether the six tiles covering Türkiye exist, and only then
 * spends an AppEEARS task. Several months share one task (the backfill
 * from BURNED_AREA_BACKFILL_FROM is a single request), so the account sees
 * one or two tasks a month in steady state.
 *
 * A deploy without EARTHDATA_USERNAME/EARTHDATA_PASSWORD, or before
 * migration 010, records 'skipped' and does nothing else.
 */
const JOB = 'burned_area';
const CMR_GRANULES_URL = 'https://cmr.earthdata.nasa.gov/search/granules.json';
const CMR_SHORT_NAME = 'MCD64A1';
const CMR_VERSION = '061';
/** W,S,E,N. Generous on purpose: it only has to touch the six tiles. */
const TURKEY_BBOX = '25.5,35.5,45.0,42.5';
/** h19v04 h19v05 h20v04 h20v05 h21v04 h21v05. */
const EXPECTED_TILES = 6;
const MAX_ATTEMPTS = 3;
const MAX_MONTHS_PER_TASK = 24;
/**
 * Pixel-to-incident match: within this of the incident's detection
 * footprint. A 500 m pixel centre can sit ~350 m from the detection that
 * burned it; 3 km also absorbs VIIRS geolocation error and the fire
 * spreading past its last detection.
 */
const INCIDENT_MATCH_RADIUS_M = 3000;
/** …and burn_date inside [first_detected − 3 d, last_detected + 7 d]. */
const INCIDENT_WINDOW_BEFORE_DAYS = 3;
const INCIDENT_WINDOW_AFTER_DAYS = 7;
const SOURCE_LABEL = 'NASA LP DAAC MCD64A1.061 via AppEEARS';
const INSERT_BATCH = 500;
class BurnedAreaJob {
    constructor() {
        this.running = false;
    }
    start() {
        console.log('🔥🛰️ Burned Area Job starting...');
        // Daily, in the quiet hours. The publish day moves (8th–20th), so a
        // monthly schedule would either miss it or wait needlessly.
        node_cron_1.default.schedule('15 3 * * *', async () => {
            await this.run();
        });
        this.run();
    }
    async run() {
        const startedAt = new Date();
        const stats = {
            months_considered: 0,
            awaiting_granules: 0,
            submitted: 0,
            polled_in_progress: 0,
            downloaded: 0,
            burned_pixels: 0,
            unattributed_pixels: 0,
            incidents_updated: 0,
            failed: 0,
            errors: 0,
        };
        if (this.running) {
            console.log('🛰️ Burned area: previous run still in progress, skipping tick');
            return stats;
        }
        this.running = true;
        try {
            // Probe first so a missing migration is the ONLY reason for the skip.
            await database_1.default.query('SELECT 1 FROM burned_area_fetches LIMIT 1');
            const credentials = (0, appeearsClient_1.credentialsFromEnv)();
            if (!credentials) {
                await (0, jobRunRecorder_1.recordJobRun)(JOB, startedAt, 'skipped', {
                    reason: 'EARTHDATA_USERNAME / EARTHDATA_PASSWORD not set — AppEEARS needs a service account',
                });
                return stats;
            }
            const client = new appeearsClient_1.AppeearsClient(credentials);
            const months = (0, burnedAreaSchedule_1.eligibleMonths)(new Date(), (0, burnedAreaSchedule_1.parseBackfillFrom)(process.env.BURNED_AREA_BACKFILL_FROM, '2025-01'));
            stats.months_considered = months.length;
            const rows = await this.loadFetches();
            await this.pollSubmitted(client, rows, stats);
            await this.submitReady(client, months, rows, stats);
            const nothingWorked = stats.errors > 0 && stats.downloaded === 0 && stats.submitted === 0 &&
                stats.polled_in_progress === 0 && stats.awaiting_granules === 0;
            await (0, jobRunRecorder_1.recordJobRun)(JOB, startedAt, nothingWorked ? 'failed' : 'ok', stats, nothingWorked ? new Error('every step failed') : undefined);
            console.log(`🛰️ Burned area done. Months ${stats.months_considered}: awaiting ${stats.awaiting_granules}, ` +
                `submitted ${stats.submitted}, in progress ${stats.polled_in_progress}, ` +
                `downloaded ${stats.downloaded} (${stats.burned_pixels} burned px, ` +
                `${stats.incidents_updated} incidents), failed ${stats.failed}, errors ${stats.errors}`);
            return stats;
        }
        catch (error) {
            if (error.code === '42P01') {
                await (0, jobRunRecorder_1.recordJobRun)(JOB, startedAt, 'skipped', {
                    reason: 'burned_area_fetches missing — apply migration 010 and run npm run seed:district-boundaries',
                });
                return stats;
            }
            console.error('Burned area job failed:', error.message);
            await (0, jobRunRecorder_1.recordJobRun)(JOB, startedAt, 'failed', stats, error);
            return stats;
        }
        finally {
            this.running = false;
        }
    }
    async loadFetches() {
        const result = await database_1.default.query(`SELECT to_char(year_month, 'YYYY-MM-DD') AS year_month, status,
              appeears_task_id, attempts
         FROM burned_area_fetches
        WHERE product = $1`, [burnedAreaRaster_1.PRODUCT]);
        const map = new Map();
        for (const row of result.rows)
            map.set(row.year_month, row);
        return map;
    }
    // ---------------------------------------------------------------------
    // Step 1 — tasks already submitted: finished? failed? still cooking?
    // ---------------------------------------------------------------------
    async pollSubmitted(client, rows, stats) {
        const byTask = new Map();
        for (const [month, row] of rows) {
            if (row.status === 'submitted' && row.appeears_task_id) {
                const list = byTask.get(row.appeears_task_id) ?? [];
                list.push(month);
                byTask.set(row.appeears_task_id, list);
            }
        }
        for (const [taskId, months] of byTask) {
            let status;
            try {
                status = (await client.getTaskStatus(taskId)).status;
            }
            catch (error) {
                stats.errors++;
                console.error(`Burned area: status of task ${taskId} failed:`, error.message);
                continue;
            }
            if (status === 'done') {
                await this.ingestTask(client, taskId, months, stats);
            }
            else if (status === 'error') {
                for (const month of months) {
                    await this.markFailed(month, `AppEEARS task ${taskId} ended in error`);
                    stats.failed++;
                }
            }
            else {
                stats.polled_in_progress += months.length;
            }
        }
    }
    async ingestTask(client, taskId, months, stats) {
        let files;
        try {
            files = await client.listBundle(taskId);
        }
        catch (error) {
            stats.errors++;
            console.error(`Burned area: bundle of task ${taskId} failed:`, error.message);
            return;
        }
        const rasters = files
            .map((file) => ({ file, meta: (0, burnedAreaRaster_1.parseBundleFileName)(file.file_name) }))
            .filter((f) => f.meta !== null && f.meta.product === burnedAreaRaster_1.PRODUCT);
        for (const month of months) {
            const burn = rasters.find((r) => r.meta.layer === 'Burn_Date' && (0, burnedAreaRaster_1.toIsoDate)(r.meta.month) === month);
            const qa = rasters.find((r) => r.meta.layer === 'QA' && (0, burnedAreaRaster_1.toIsoDate)(r.meta.month) === month);
            if (!burn) {
                await this.markFailed(month, `Burn_Date raster for ${month} missing from bundle ${taskId}`);
                stats.failed++;
                continue;
            }
            try {
                const burnBuffer = await client.downloadFile(taskId, burn.file.file_id);
                const qaBuffer = qa ? await client.downloadFile(taskId, qa.file.file_id) : null;
                const summary = await (0, burnedAreaRaster_1.extractBurnedPixels)(burnBuffer, qaBuffer, Number(month.slice(0, 4)));
                const stored = await this.storeMonth(month, summary);
                stats.downloaded++;
                stats.burned_pixels += summary.burnedPixelCount;
                stats.unattributed_pixels += stored.unattributed;
                stats.incidents_updated += stored.incidentsUpdated;
                console.log(`🛰️ Burned area ${month}: ${summary.burnedPixelCount} burned px ` +
                    `(${(summary.burnedPixelCount * burnedAreaRaster_1.PIXEL_HECTARES).toFixed(0)} ha), ` +
                    `${stored.unattributed} outside any district, ${stored.incidentsUpdated} incidents`);
            }
            catch (error) {
                if (error.code === '42P01')
                    throw error;
                await this.markFailed(month, error.message);
                stats.failed++;
                console.error(`Burned area: ingest of ${month} failed:`, error.message);
            }
        }
    }
    /** One transaction per month: pixels, district sums, incident axis, state. */
    async storeMonth(month, summary) {
        const db = await database_1.default.connect();
        try {
            await db.query('BEGIN');
            await db.query(`DELETE FROM burned_pixels WHERE product = $1 AND year_month = $2`, [burnedAreaRaster_1.PRODUCT, month]);
            for (let i = 0; i < summary.pixels.length; i += INSERT_BATCH) {
                const batch = summary.pixels.slice(i, i + INSERT_BATCH);
                const values = [burnedAreaRaster_1.PRODUCT, month];
                const tuples = batch.map((p) => {
                    const base = values.length;
                    values.push(p.row, p.col, (0, burnedAreaRaster_1.toIsoDate)(p.burnDate), p.qa, p.lon, p.lat);
                    return `($1, $2, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4},
                   ST_SetSRID(ST_MakePoint($${base + 5}, $${base + 6}), 4326))`;
                });
                await db.query(`INSERT INTO burned_pixels
             (product, year_month, raster_row, raster_col, burn_date, qa, location)
           VALUES ${tuples.join(',')}
           ON CONFLICT DO NOTHING`, values);
            }
            await db.query(`UPDATE burned_pixels p
            SET district_id = b.district_id
           FROM turkey_district_boundaries b
          WHERE p.product = $1 AND p.year_month = $2
            AND ST_Contains(b.geom, p.location)`, [burnedAreaRaster_1.PRODUCT, month]);
            // Nearest incident whose footprint is within the radius and whose
            // detection window contains the burn date. Pixels in 2025 find nothing
            // (incidents begin in Aug 2026); that is correct, not a bug.
            await db.query(`UPDATE burned_pixels p
            SET incident_id = m.incident_id
           FROM (
             SELECT p2.raster_row, p2.raster_col,
                    (SELECT i.id
                       FROM fire_incidents i
                      WHERE ST_DWithin(i.footprint::geography, p2.location::geography, $3)
                        AND p2.burn_date >= (i.first_detected_at AT TIME ZONE 'UTC')::date - $4::int
                        AND p2.burn_date <= (i.last_detected_at  AT TIME ZONE 'UTC')::date + $5::int
                      ORDER BY ST_Distance(i.centroid::geography, p2.location::geography)
                      LIMIT 1) AS incident_id
               FROM burned_pixels p2
              WHERE p2.product = $1 AND p2.year_month = $2
           ) m
          WHERE p.product = $1 AND p.year_month = $2
            AND p.raster_row = m.raster_row AND p.raster_col = m.raster_col
            AND m.incident_id IS NOT NULL`, [burnedAreaRaster_1.PRODUCT, month, INCIDENT_MATCH_RADIUS_M, INCIDENT_WINDOW_BEFORE_DAYS, INCIDENT_WINDOW_AFTER_DAYS]);
            await db.query(`DELETE FROM burned_area_monthly WHERE product = $1 AND year_month = $2`, [burnedAreaRaster_1.PRODUCT, month]);
            await db.query(`INSERT INTO burned_area_monthly
           (district_id, year_month, product, hectares, pixel_count, fetched_at, source)
         SELECT district_id, $2::date, $1, round(count(*) * $3::numeric, 2), count(*), NOW(), $4
           FROM burned_pixels
          WHERE product = $1 AND year_month = $2 AND district_id IS NOT NULL
          GROUP BY district_id`, [burnedAreaRaster_1.PRODUCT, month, burnedAreaRaster_1.PIXEL_HECTARES, SOURCE_LABEL]);
            // AXIS 2 on the incidents this month touched. Summed over ALL months'
            // pixels for those incidents, so a fire straddling a month boundary is
            // not halved.
            const incidents = await db.query(`UPDATE fire_incidents i
            SET optical_burnt_area_ha = agg.hectares,
                optical_fire_date     = agg.first_burn,
                optical_source        = $3,
                optical_last_update   = NOW(),
                optical_matched_at    = COALESCE(i.optical_matched_at, NOW()),
                updated_at            = NOW()
           FROM (
             SELECT incident_id,
                    round(count(*) * $4::numeric, 2) AS hectares,
                    min(burn_date)::timestamptz     AS first_burn
               FROM burned_pixels
              WHERE product = $1
                AND incident_id IN (
                  SELECT DISTINCT incident_id FROM burned_pixels
                   WHERE product = $1 AND year_month = $2 AND incident_id IS NOT NULL)
              GROUP BY incident_id
           ) agg
          WHERE i.id = agg.incident_id`, [burnedAreaRaster_1.PRODUCT, month, burnedAreaRaster_1.PRODUCT, burnedAreaRaster_1.PIXEL_HECTARES]);
            const unattributed = await db.query(`SELECT count(*)::int AS n FROM burned_pixels
          WHERE product = $1 AND year_month = $2 AND district_id IS NULL`, [burnedAreaRaster_1.PRODUCT, month]);
            await db.query(`UPDATE burned_area_fetches
            SET status = 'downloaded', downloaded_at = NOW(),
                pixel_count = $3, burned_pixel_count = $4, unattributed_count = $5,
                last_error = NULL, updated_at = NOW()
          WHERE product = $1 AND year_month = $2`, [burnedAreaRaster_1.PRODUCT, month, summary.pixelCount, summary.burnedPixelCount, unattributed.rows[0].n]);
            await db.query('COMMIT');
            return { unattributed: Number(unattributed.rows[0].n), incidentsUpdated: incidents.rowCount ?? 0 };
        }
        catch (error) {
            await db.query('ROLLBACK');
            throw error;
        }
        finally {
            db.release();
        }
    }
    async markFailed(month, message) {
        await database_1.default.query(`UPDATE burned_area_fetches
          SET status = 'failed', last_error = left($3, 500), updated_at = NOW()
        WHERE product = $1 AND year_month = $2`, [burnedAreaRaster_1.PRODUCT, month, message]);
    }
    // ---------------------------------------------------------------------
    // Step 2 — months not yet fetched: published? then one task for all.
    // ---------------------------------------------------------------------
    async submitReady(client, months, rows, stats) {
        const ready = [];
        for (const month of months) {
            const key = (0, burnedAreaRaster_1.toIsoDate)(month);
            const row = rows.get(key);
            const candidate = !row ||
                row.status === 'awaiting_granules' ||
                (row.status === 'failed' && row.attempts < MAX_ATTEMPTS);
            if (!candidate)
                continue;
            let tiles;
            try {
                tiles = await this.cmrGranuleCount(month);
            }
            catch (error) {
                stats.errors++;
                console.error(`Burned area: CMR check for ${key} failed:`, error.message);
                continue;
            }
            await database_1.default.query(`INSERT INTO burned_area_fetches (product, year_month, status, granule_count)
         VALUES ($1, $2, 'awaiting_granules', $3)
         ON CONFLICT (product, year_month) DO UPDATE
            SET granule_count = EXCLUDED.granule_count, updated_at = NOW()`, [burnedAreaRaster_1.PRODUCT, key, tiles]);
            if (tiles >= EXPECTED_TILES)
                ready.push(month);
            else
                stats.awaiting_granules++;
        }
        if (ready.length === 0)
            return;
        const geo = await this.countryGeoJson();
        for (let i = 0; i < ready.length; i += MAX_MONTHS_PER_TASK) {
            const chunk = ready.slice(i, i + MAX_MONTHS_PER_TASK);
            const first = (0, burnedAreaRaster_1.toIsoDate)(chunk[0]).slice(0, 7);
            const last = (0, burnedAreaRaster_1.toIsoDate)(chunk[chunk.length - 1]).slice(0, 7);
            try {
                const taskId = await client.submitAreaTask({
                    taskName: chunk.length === 1 ? `firewatch-tr-mcd64a1-${first}` : `firewatch-tr-mcd64a1-${first}-${last}`,
                    dates: chunk.map((m) => ({
                        startDate: (0, appeearsClient_1.toAppeearsDate)(m),
                        endDate: (0, appeearsClient_1.toAppeearsDate)((0, burnedAreaSchedule_1.lastDayOfMonthUTC)(m)),
                    })),
                    layers: [
                        { product: burnedAreaRaster_1.PRODUCT, layer: 'Burn_Date' },
                        { product: burnedAreaRaster_1.PRODUCT, layer: 'QA' },
                    ],
                    geo,
                    projection: 'native',
                });
                for (const m of chunk) {
                    await database_1.default.query(`UPDATE burned_area_fetches
                SET status = 'submitted', appeears_task_id = $3, submitted_at = NOW(),
                    attempts = attempts + 1, last_error = NULL, updated_at = NOW()
              WHERE product = $1 AND year_month = $2`, [burnedAreaRaster_1.PRODUCT, (0, burnedAreaRaster_1.toIsoDate)(m), taskId]);
                }
                stats.submitted += chunk.length;
                console.log(`🛰️ Burned area: submitted AppEEARS task ${taskId} for ${chunk.length} month(s) ${first}..${last}`);
            }
            catch (error) {
                stats.errors++;
                const message = axios_1.default.isAxiosError(error)
                    ? `${error.message}: ${JSON.stringify(error.response?.data ?? '').slice(0, 300)}`
                    : error.message;
                console.error('Burned area: AppEEARS submit failed:', message);
                for (const m of chunk) {
                    await database_1.default.query(`UPDATE burned_area_fetches
                SET status = 'failed', attempts = attempts + 1, last_error = left($3, 500), updated_at = NOW()
              WHERE product = $1 AND year_month = $2`, [burnedAreaRaster_1.PRODUCT, (0, burnedAreaRaster_1.toIsoDate)(m), message]);
                }
            }
        }
    }
    /** How many MCD64A1 tiles CMR lists over Türkiye for the month. Public, no auth. */
    async cmrGranuleCount(month) {
        const start = `${(0, burnedAreaRaster_1.toIsoDate)(month)}T00:00:00Z`;
        const end = `${(0, burnedAreaRaster_1.toIsoDate)((0, burnedAreaSchedule_1.addDaysUTC)(month, 1))}T00:00:00Z`;
        const response = await axios_1.default.get(CMR_GRANULES_URL, {
            params: {
                short_name: CMR_SHORT_NAME,
                version: CMR_VERSION,
                bounding_box: TURKEY_BBOX,
                temporal: `${start},${end}`,
                page_size: 50,
            },
            timeout: 30000,
        });
        const hits = Number(response.headers['cmr-hits']);
        if (Number.isFinite(hits))
            return hits;
        return Array.isArray(response.data?.feed?.entry) ? response.data.feed.entry.length : 0;
    }
    /** The country polygon migration 003 loaded, as a one-feature FeatureCollection. */
    async countryGeoJson() {
        const result = await database_1.default.query(`SELECT ST_AsGeoJSON(geom, 5) AS geojson FROM country_borders WHERE iso_a3 = 'TUR'`);
        if (result.rows.length === 0)
            throw new Error('country_borders has no TUR row (migration 003)');
        return {
            type: 'FeatureCollection',
            features: [
                { type: 'Feature', properties: { name: 'Türkiye' }, geometry: JSON.parse(result.rows[0].geojson) },
            ],
        };
    }
}
exports.default = new BurnedAreaJob();
