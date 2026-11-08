"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const database_1 = __importDefault(require("../config/database"));
const cacheService_1 = __importDefault(require("../services/cacheService"));
const nearbyFireCount_1 = require("../services/nearbyFireCount");
const weatherSource_1 = require("../services/weatherSource");
const notificationService_1 = __importDefault(require("../services/notificationService"));
const alertText_1 = require("../services/alertText");
const regions_1 = require("../utils/regions");
const riskScore_1 = require("../services/riskScore");
const REGIONS = [
    { name: 'Ege', display: 'Ege', lat: 38.42, lng: 27.14 },
    { name: 'Akdeniz', display: 'Akdeniz', lat: 36.9, lng: 30.7 },
    { name: 'Marmara', display: 'Marmara', lat: 40.18, lng: 29.07 },
    { name: 'Karadeniz', display: 'Karadeniz', lat: 41.28, lng: 36.33 },
    { name: 'Ic Anadolu', display: 'İç Anadolu', lat: 39.93, lng: 32.86 },
    { name: 'Dogu Anadolu', display: 'Doğu Anadolu', lat: 39.9, lng: 41.27 },
    { name: 'Guneydogu Anadolu', display: 'Güneydoğu Anadolu', lat: 37.07, lng: 37.38 },
];
const RISK_ALERT_THRESHOLD = 70;
const RISK_ALERT_TTL_SECONDS = 6 * 60 * 60;
const CRITICAL_FIRE_THRESHOLD = 5;
const CRITICAL_ALERT_TTL_SECONDS = 3 * 60 * 60;
class RiskCalculatorJob {
    start() {
        console.log('Risk Calculator Job starting...');
        node_cron_1.default.schedule('0 */3 * * *', async () => {
            await this.runCalculator();
        });
        this.runCalculator();
    }
    async runCalculator() {
        console.log('Running risk calculator at:', new Date().toISOString());
        // The fire component is the app's own count: incidents of the last
        // 24 h inside Turkey, fixed heat sources excluded — the same number
        // /api/risk/summary shows as nearby_fire_count. Null means ingest or
        // clustering is more than 6 h stale; then no row is written, because a
        // score computed without its fire part would read as "no fires".
        const fireStatsByRegion = await (0, nearbyFireCount_1.loadRegionFireStats)(database_1.default);
        if (fireStatsByRegion === null) {
            console.error('Risk calculator skipped: fire counts unavailable (ingest/cluster stale or unreadable)');
            return;
        }
        // All regions in one request. A region with no reading gets no row, so
        // the published score ages and is marked stale instead of being invented.
        const readings = await weatherSource_1.weatherSource.readMany(REGIONS, 'regions');
        for (const region of REGIONS) {
            try {
                const reading = readings.get((0, weatherSource_1.weatherCellKey)(region.lat, region.lng));
                if (!reading)
                    throw new Error('weather unavailable from every provider');
                const weather = reading.weather;
                const fireStats = this.fireStatsFor(region, fireStatsByRegion);
                const risk = (0, riskScore_1.calculateRisk)(weather, fireStats.incidents);
                await database_1.default.query(`INSERT INTO risk_data
            (region, date, general_risk_score, risk_level, temperature, humidity,
             wind_speed, wind_direction, dryness_index, vegetation_density)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
                    region.name,
                    new Date(),
                    risk.score,
                    risk.level,
                    weather.temperature,
                    weather.humidity,
                    weather.windSpeed,
                    weather.windDirection,
                    risk.drynessIndex,
                    risk.vegetationPressure,
                ]);
                console.log(`OK ${region.name}: Score=${risk.score}, Temp=${weather.temperature}, Hum=${weather.humidity}, Wind=${weather.windSpeed}, Fire=${fireStats.incidents} (db, 24h), HighConf=${fireStats.highConfidence}`);
                // Best-effort: a notification failure must never take down the
                // calculator loop or skip the risk_data row already just written.
                await this.maybeSendRiskAlert(region, risk, weather).catch((err) => console.error(`Risk alert failed for ${region.name}:`, err.message));
                await this.maybeSendCriticalFireAlert(region, fireStats.highConfidence).catch((err) => console.error(`Critical alert failed for ${region.name}:`, err.message));
            }
            catch (error) {
                console.error(`Error for ${region.name}:`, error.message);
            }
        }
        await cacheService_1.default.delete('risk:summary');
        console.log('Risk calculator completed');
    }
    fireStatsFor(region, stats) {
        const key = (0, regions_1.regionKeyForRegionName)(region.name) ?? (0, regions_1.regionKeyForCoordinates)(region.lat, region.lng);
        return (key && stats.get(key)) ?? { incidents: 0, highConfidence: 0 };
    }
    async cityIdsInRegion(regionKey) {
        if (regionKey === null)
            return [];
        if (RiskCalculatorJob.cityRegionCache === null) {
            const result = await database_1.default.query(`SELECT id, region,
                ST_Y(location::geometry) AS lat,
                ST_X(location::geometry) AS lng
         FROM turkey_cities`);
            const cache = new Map();
            for (const row of result.rows) {
                const key = (0, regions_1.regionKeyForRegionName)(row.region) ??
                    (row.lat !== null && row.lng !== null
                        ? (0, regions_1.regionKeyForCoordinates)(Number(row.lat), Number(row.lng))
                        : null);
                if (key === null)
                    continue;
                const list = cache.get(key) ?? [];
                list.push(Number(row.id));
                cache.set(key, list);
            }
            RiskCalculatorJob.cityRegionCache = cache;
        }
        return RiskCalculatorJob.cityRegionCache.get(regionKey) ?? [];
    }
    // No LIMIT: notificationService.sendToTokens chunks into 500s internally, so
    // every matching device is reached. The old `LIMIT 500` silently excluded
    // every device past the 500th from region risk alerts.
    //
    // A city-scoped device matches when ITS OWN province sits in the region being
    // alerted — not when its province happens to be the one nearest the region's
    // representative point. That earlier version meant e.g. Ege's representative
    // point resolves to İzmir, so a Muğla user on 'city' scope would never have
    // received an Ege risk alert at all.
    async getActiveTokensNearRegion(region) {
        const regionKey = (0, regions_1.regionKeyForRegionName)(region.name) ??
            (0, regions_1.regionKeyForCoordinates)(region.lat, region.lng);
        const cityIds = await this.cityIdsInRegion(regionKey);
        const result = await database_1.default.query(`SELECT t.token FROM fcm_tokens t
       WHERE t.is_active = true
         AND (
           t.latitude IS NULL OR t.longitude IS NULL
           OR ST_DWithin(
             ST_SetSRID(ST_MakePoint(t.longitude, t.latitude), 4326)::geography,
             ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
             $3
           )
         )
         AND (
           t.alert_scope = 'all'
           OR (t.alert_scope = 'region' AND t.region_key IS NOT NULL AND t.region_key = $4)
           OR (t.alert_scope = 'city' AND t.city_id IS NOT NULL AND t.city_id = ANY($5::int[]))
         )`, [region.lng, region.lat, RiskCalculatorJob.REGION_RADIUS_METERS, regionKey, cityIds]);
        return result.rows.map((row) => row.token);
    }
    async maybeSendRiskAlert(region, risk, weather) {
        if (risk.score < RISK_ALERT_THRESHOLD)
            return;
        const cacheKey = `notif:region:${region.name}`;
        if (await cacheService_1.default.get(cacheKey))
            return;
        const tokens = await this.getActiveTokensNearRegion(region);
        if (tokens.length === 0)
            return;
        const text = (0, alertText_1.riskAlertText)({
            regionDisplay: region.display,
            score: risk.score,
            temperature: weather.temperature,
            humidity: weather.humidity,
            windSpeed: weather.windSpeed,
        });
        await notificationService_1.default.sendToTokens(tokens, text.title, text.body);
        await cacheService_1.default.set(cacheKey, true, RISK_ALERT_TTL_SECONDS);
    }
    async maybeSendCriticalFireAlert(region, highConfidenceCount) {
        if (highConfidenceCount <= CRITICAL_FIRE_THRESHOLD)
            return;
        const cacheKey = `notif:critical:${region.name}`;
        if (await cacheService_1.default.get(cacheKey))
            return;
        const tokens = await this.getActiveTokensNearRegion(region);
        if (tokens.length === 0)
            return;
        const text = (0, alertText_1.multipleDetectionsAlertText)(region.display, highConfidenceCount);
        await notificationService_1.default.sendToTokens(tokens, text.title, text.body);
        await cacheService_1.default.set(cacheKey, true, CRITICAL_ALERT_TTL_SECONDS);
    }
}
// Region radius is generous (400km) since REGIONS' lat/lng are single
// representative points for areas that actually span a few hundred km —
// a tight radius would miss users at the edges of their own region.
// Tokens with no stored location match every region's alert rather than
// none — we'd rather over-notify a user we can't place than silently
// never notify them at all.
RiskCalculatorJob.REGION_RADIUS_METERS = 400000;
// No LIMIT: notificationService.sendToTokens chunks into 500s internally, so
// every matching device is reached. The old `LIMIT 500` silently excluded
// every device past the 500th from region risk alerts.
//
// The alert_scope clause layers the user's explicit choice on top of the
// proximity match: a device that asked for city-only alerts is not woken by
// a region-wide risk notice unless that region's representative point
// resolves to their own city.
/**
 * Every province that belongs to a region, memoised — turkey_cities is a
 * static 81-row table.
 *
 * The province's own `region` column is authoritative; the coordinate boxes
 * are only a fallback for rows where it is missing or spelled in a way we
 * don't recognise. Getting this wrong silently mutes users, so neither
 * source is trusted alone.
 */
RiskCalculatorJob.cityRegionCache = null;
exports.default = new RiskCalculatorJob();
