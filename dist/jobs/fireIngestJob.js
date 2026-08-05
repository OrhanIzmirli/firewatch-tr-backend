"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseAcquiredAt = parseAcquiredAt;
exports.confidenceTier = confidenceTier;
const node_cron_1 = __importDefault(require("node-cron"));
const axios_1 = __importDefault(require("axios"));
const database_1 = __importDefault(require("../config/database"));
const locationService_1 = require("../services/locationService");
/**
 * Persists raw FIRMS thermal detections into fire_detections.
 *
 * This runs ALONGSIDE /api/thermal, not instead of it. That route stays a
 * pure pass-through proxy for the shipped app; this job exists so that
 * duration, spread and "is it still burning" can be computed later from an
 * actual history instead of a five-minute Redis cache.
 */
// Same box the thermal proxy asks FIRMS for: west,south,east,north.
const FIRMS_AREA = '25,35,45,43';
// Overridable so the ingest path can be exercised against a local fixture
// server without a NASA key. Production leaves it unset and hits FIRMS.
const FIRMS_BASE = process.env.FIRMS_BASE_URL ?? 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
// Same fallback ladder as routes/thermal.ts, so ingest sees the same data the
// app sees. MODIS uses different column names — see normaliseRow.
const PRODUCT_ATTEMPTS = [
    { product: 'VIIRS_SNPP_NRT', days: 1 },
    { product: 'MODIS_NRT', days: 1 },
    { product: 'VIIRS_SNPP_NRT', days: 2 },
];
/**
 * Turkey's bounding box — identical values to routes/fires.ts, deliberately,
 * so "inside Turkey" means one thing across the codebase.
 */
const TURKEY_BBOX = { minLat: 35.8, maxLat: 42.2, minLng: 25.6, maxLng: 44.8 };
/**
 * Secondary guard on top of the bounding box.
 *
 * turkey_cities holds ONE POINT per province (its centre), not a border
 * polygon, so no distance threshold can trace the actual frontier. Turkey's
 * 81 provinces average ~9,700 km²; even the large eastern ones put an
 * interior point within roughly 150 km of its provincial centre. 250 km is
 * therefore comfortably above anything legitimately Turkish while still
 * discarding far-flung points that slipped through the box.
 *
 * The bias is intentional: keeping a Syrian detection is a cosmetic problem,
 * dropping a real Turkish one is a safety problem. Points in Greek Thrace,
 * Bulgaria, the Aegean islands, Cyprus or the Syrian/Iraqi border strip WILL
 * still be stored — they are inside the box and near a Turkish province
 * centre. nearest_city_km is persisted on every row precisely so a proper
 * border polygon can filter them later without re-ingesting anything.
 */
const MAX_NEAREST_CITY_KM = 250;
/** Raw detections older than this are pruned after each run. */
const RETENTION_DAYS = 90;
/**
 * FIRMS sends acq_time as an UNPADDED HHMM integer in UTC: "3" is 00:03,
 * "45" is 00:45, "1330" is 13:30. Reading it as hours, or as a padded
 * string, shifts every timestamp — and every duration and spread figure
 * computed from it later.
 */
function parseAcquiredAt(acqDate, acqTime) {
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(acqDate.trim());
    if (!dateMatch)
        return null;
    const raw = Number.parseInt(acqTime.trim(), 10);
    if (!Number.isFinite(raw) || raw < 0 || raw > 2359)
        return null;
    const hours = Math.floor(raw / 100);
    const minutes = raw % 100;
    if (hours > 23 || minutes > 59)
        return null;
    return new Date(Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]), hours, minutes, 0));
}
/**
 * Normalises confidence to a tier using EXACTLY the thresholds the Flutter
 * client applies in FirePoint.riskTier: numeric >=80 high, >=30 medium,
 * else low; letters h/high high, n/nominal medium, else low.
 *
 * The one difference is vocabulary — the client calls the middle tier
 * 'medium', FIRMS calls it 'nominal' and so do we. The boundaries are the
 * same, which is what matters for "high confidence" meaning one thing.
 */
function confidenceTier(raw) {
    const value = raw.toLowerCase().trim();
    const numeric = Number.parseInt(value, 10);
    if (Number.isFinite(numeric) && /^\d+$/.test(value)) {
        if (numeric >= 80)
            return 'high';
        if (numeric >= 30)
            return 'nominal';
        return 'low';
    }
    if (value.includes('high') || value === 'h')
        return 'high';
    if (value.includes('nominal') || value === 'n')
        return 'nominal';
    return 'low';
}
function numberOrNull(value) {
    if (value === undefined)
        return null;
    const trimmed = value.trim();
    if (trimmed === '')
        return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}
/**
 * Maps one CSV row onto the common shape, coping with the fact that the two
 * products do not share column names:
 *
 *   VIIRS_SNPP_NRT: latitude,longitude,bright_ti4,scan,track,acq_date,
 *                   acq_time,satellite,instrument,confidence,version,
 *                   bright_ti5,frp,daynight
 *   MODIS_NRT:      ...,brightness,...,bright_t31,...
 *
 * Which one arrived is decided from the header, never assumed from the
 * product name — the fallback ladder means either can turn up.
 */
function normaliseRow(columns, cells, product) {
    const get = (name) => {
        const index = columns.get(name);
        return index === undefined ? undefined : cells[index];
    };
    const latitude = numberOrNull(get('latitude'));
    const longitude = numberOrNull(get('longitude'));
    if (latitude === null || longitude === null)
        return null;
    const acqDate = get('acq_date');
    const acqTime = get('acq_time');
    if (acqDate === undefined || acqTime === undefined)
        return null;
    const acquiredAt = parseAcquiredAt(acqDate, acqTime);
    if (acquiredAt === null)
        return null;
    const confidenceRaw = (get('confidence') ?? '').trim();
    if (confidenceRaw === '')
        return null;
    // bright_ti4 is VIIRS' I-4 channel, brightness is MODIS' equivalent;
    // bright_ti5 / bright_t31 are the respective second channels.
    const brightnessK = numberOrNull(get('bright_ti4') ?? get('brightness'));
    const brightness2K = numberOrNull(get('bright_ti5') ?? get('bright_t31'));
    return {
        product,
        acquiredAt,
        latitude,
        longitude,
        satellite: get('satellite')?.trim() || null,
        instrument: get('instrument')?.trim() || null,
        confidenceRaw,
        confidenceTier: confidenceTier(confidenceRaw),
        brightnessK,
        brightness2K,
        frpMw: numberOrNull(get('frp')),
        scanKm: numberOrNull(get('scan')),
        trackKm: numberOrNull(get('track')),
        daynight: get('daynight')?.trim().charAt(0) || null,
    };
}
function isWithinTurkeyBbox(lat, lng) {
    return (lat >= TURKEY_BBOX.minLat &&
        lat <= TURKEY_BBOX.maxLat &&
        lng >= TURKEY_BBOX.minLng &&
        lng <= TURKEY_BBOX.maxLng);
}
class FireIngestJob {
    start() {
        console.log('🛰️  Fire Ingest Job starting...');
        node_cron_1.default.schedule('*/30 * * * *', async () => {
            await this.runIngest();
        });
        this.runIngest();
    }
    /**
     * The code can be deployed before migration 002 has been applied — that is
     * the expected order, since the migration is run by hand. Missing table is
     * therefore a normal state, not an error: skip quietly and say why.
     */
    async tableExists() {
        const result = await database_1.default.query(`SELECT to_regclass('public.fire_detections') AS table_name`);
        return result.rows[0]?.table_name !== null;
    }
    async runIngest() {
        const stats = {
            product: null,
            fetched: 0,
            malformed: 0,
            outsideBbox: 0,
            outsideCityRadius: 0,
            inserted: 0,
            duplicates: 0,
            pruned: 0,
        };
        try {
            if (!(await this.tableExists())) {
                console.log('⏭️  fire_detections does not exist — skipping ingest. ' +
                    'Apply database/migrations/002_add_fire_detections.sql first.');
                return stats;
            }
            const apiKey = process.env.NASA_API_KEY;
            if (!apiKey) {
                console.warn('⚠️  NASA_API_KEY not set — fire ingest skipped');
                return stats;
            }
            const fetched = await this.fetchFirstProductWithData(apiKey);
            if (fetched === null) {
                console.warn('⚠️  No FIRMS product returned data — nothing ingested');
                return stats;
            }
            stats.product = fetched.product;
            const detections = this.parseCsv(fetched.csv, fetched.product, stats);
            await this.persist(detections, stats);
            stats.pruned = await this.pruneOldDetections();
            console.log(`🛰️  Ingest ${stats.product}: fetched ${stats.fetched}, ` +
                `inserted ${stats.inserted}, duplicates ${stats.duplicates}, ` +
                `outside bbox ${stats.outsideBbox}, beyond ${MAX_NEAREST_CITY_KM}km ` +
                `${stats.outsideCityRadius}, malformed ${stats.malformed}, ` +
                `pruned ${stats.pruned}`);
            return stats;
        }
        catch (error) {
            console.error('❌ Fire ingest failed:', error.message);
            return stats;
        }
    }
    async fetchFirstProductWithData(apiKey) {
        // Lets verification force a specific product so the MODIS column-mapping
        // path can be exercised without waiting for VIIRS to return nothing.
        const forced = process.env.FIRMS_FORCE_PRODUCT;
        const attempts = forced
            ? [{ product: forced, days: 1 }, ...PRODUCT_ATTEMPTS]
            : PRODUCT_ATTEMPTS;
        for (const attempt of attempts) {
            try {
                const url = `${FIRMS_BASE}/${encodeURIComponent(apiKey)}/${attempt.product}/${FIRMS_AREA}/${attempt.days}`;
                const response = await axios_1.default.get(url, {
                    timeout: 20000,
                    responseType: 'text',
                });
                const csv = response.data;
                if (csv.trim().split(/\r?\n/).filter(Boolean).length > 1) {
                    return { product: attempt.product, csv };
                }
            }
            catch (error) {
                console.warn(`FIRMS ${attempt.product} fetch failed:`, error.message);
            }
        }
        return null;
    }
    parseCsv(csv, product, stats) {
        const lines = csv.trim().split(/\r?\n/).filter(Boolean);
        if (lines.length <= 1)
            return [];
        const header = lines[0].split(',').map((name) => name.trim().toLowerCase());
        const columns = new Map();
        header.forEach((name, index) => columns.set(name, index));
        const detections = [];
        for (let i = 1; i < lines.length; i++) {
            stats.fetched++;
            const cells = lines[i].split(',');
            const detection = normaliseRow(columns, cells, product);
            if (detection === null) {
                stats.malformed++;
                continue;
            }
            if (!isWithinTurkeyBbox(detection.latitude, detection.longitude)) {
                stats.outsideBbox++;
                continue;
            }
            detections.push(detection);
        }
        return detections;
    }
    /**
     * Resolves the nearest province and region for each detection, then inserts.
     * ON CONFLICT DO NOTHING against the natural key makes re-running the same
     * fetch a no-op rather than a duplicate.
     */
    async persist(detections, stats) {
        for (const detection of detections) {
            // Same resolver the subscription and alert paths use, so a detection's
            // region can never disagree with the region a device subscribed to.
            const nearest = await (0, locationService_1.resolveLocation)(detection.latitude, detection.longitude);
            if (nearest.distanceKm !== null && nearest.distanceKm > MAX_NEAREST_CITY_KM) {
                stats.outsideCityRadius++;
                continue;
            }
            const regionKey = nearest.regionKey;
            const result = await database_1.default.query(`INSERT INTO fire_detections (
           product, acquired_at, latitude, longitude, geom,
           satellite, instrument, confidence_raw, confidence_tier,
           brightness_k, brightness2_k, frp_mw, scan_km, track_km, daynight,
           city_id, nearest_city_km, region_key
         ) VALUES (
           -- Explicit casts: $3/$4 feed both a NUMERIC column and
           -- ST_MakePoint's double precision arguments, and Postgres refuses
           -- to deduce two types for one parameter.
           $1, $2, $3::numeric, $4::numeric,
           ST_SetSRID(ST_MakePoint($4::double precision, $3::double precision), 4326),
           $5, $6, $7, $8,
           $9, $10, $11, $12, $13, $14,
           $15, $16, $17
         )
         ON CONFLICT ON CONSTRAINT fire_detections_natural_key DO NOTHING`, [
                detection.product,
                detection.acquiredAt,
                detection.latitude,
                detection.longitude,
                detection.satellite,
                detection.instrument,
                detection.confidenceRaw,
                detection.confidenceTier,
                detection.brightnessK,
                detection.brightness2K,
                detection.frpMw,
                detection.scanKm,
                detection.trackKm,
                detection.daynight,
                nearest.cityId,
                nearest.distanceKm,
                regionKey,
            ]);
            if ((result.rowCount ?? 0) > 0)
                stats.inserted++;
            else
                stats.duplicates++;
        }
    }
    /**
     * Raw pixels are only needed while they can still be clustered into or
     * extend an incident. Everything older is dead weight — measured volume is
     * roughly 400 detections/day off-season, so 90 days is well under any
     * storage concern while keeping a full season's tail available.
     */
    async pruneOldDetections() {
        const result = await database_1.default.query(`DELETE FROM fire_detections
       WHERE acquired_at < NOW() - INTERVAL '${RETENTION_DAYS} days'`);
        return result.rowCount ?? 0;
    }
}
exports.default = new FireIngestJob();
