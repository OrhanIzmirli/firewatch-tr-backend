"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const axios_1 = __importDefault(require("axios"));
const database_1 = __importDefault(require("../config/database"));
const cacheService_1 = __importDefault(require("../services/cacheService"));
const notificationService_1 = __importDefault(require("../services/notificationService"));
const regions_1 = require("../utils/regions");
const REGIONS = [
    { name: 'Ege', display: 'Ege', lat: 38.42, lng: 27.14 },
    { name: 'Akdeniz', display: 'Akdeniz', lat: 36.9, lng: 30.7 },
    { name: 'Marmara', display: 'Marmara', lat: 40.18, lng: 29.07 },
    { name: 'Karadeniz', display: 'Karadeniz', lat: 41.28, lng: 36.33 },
    { name: 'Ic Anadolu', display: 'İç Anadolu', lat: 39.93, lng: 32.86 },
    { name: 'Dogu Anadolu', display: 'Doğu Anadolu', lat: 39.9, lng: 41.27 },
    { name: 'Guneydogu Anadolu', display: 'Güneydoğu Anadolu', lat: 37.07, lng: 37.38 },
];
const CACHE_TTL = 300; // 5 dakika
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
        for (const region of REGIONS) {
            try {
                const weather = await this.fetchWeather(region.lat, region.lng);
                const fireStats = await this.fetchFireStats(region.lat, region.lng);
                const risk = this.calculateRisk(weather, fireStats.total);
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
                console.log(`OK ${region.name}: Score=${risk.score}, Temp=${weather.temperature}, Hum=${weather.humidity}, Wind=${weather.windSpeed}, Fire=${fireStats.total}, HighConf=${fireStats.highConfidence}`);
                // Best-effort: a notification failure must never take down the
                // calculator loop or skip the risk_data row already just written.
                await this.maybeSendRiskAlert(region, risk).catch((err) => console.error(`Risk alert failed for ${region.name}:`, err.message));
                await this.maybeSendCriticalFireAlert(region, fireStats.highConfidence).catch((err) => console.error(`Critical alert failed for ${region.name}:`, err.message));
            }
            catch (error) {
                console.error(`Error for ${region.name}:`, error.message);
            }
        }
        await cacheService_1.default.delete('risk:summary');
        console.log('Risk calculator completed');
    }
    async fetchWeather(lat, lng) {
        const cacheKey = `weather:${lat}:${lng}`;
        const cached = await cacheService_1.default.get(cacheKey);
        if (cached) {
            console.log(`Cache HIT: ${cacheKey}`);
            return cached;
        }
        const response = await axios_1.default.get('https://api.open-meteo.com/v1/forecast', {
            params: {
                latitude: lat,
                longitude: lng,
                current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m',
                wind_speed_unit: 'kmh',
            },
            timeout: 10000,
        });
        const current = response.data.current;
        const windDeg = current.wind_direction_10m ?? 0;
        const data = {
            temperature: Math.round(current.temperature_2m),
            humidity: Math.round(current.relative_humidity_2m),
            windSpeed: Math.round(current.wind_speed_10m),
            windDirection: this.degToDirection(windDeg),
        };
        await cacheService_1.default.set(cacheKey, data, CACHE_TTL);
        return data;
    }
    async fetchFireStats(lat, lng) {
        const cacheKey = `nasa:fires:${lat}:${lng}`;
        const cached = await cacheService_1.default.get(cacheKey);
        if (cached !== null) {
            console.log(`Cache HIT: ${cacheKey}`);
            return cached;
        }
        const nasaApiKey = process.env.NASA_API_KEY;
        if (!nasaApiKey)
            throw new Error('NASA_API_KEY is not configured');
        try {
            const area = `${lng - 2},${lat - 2},${lng + 2},${lat + 2}`;
            const attempts = [
                { product: 'VIIRS_SNPP_NRT', days: 1 },
                { product: 'MODIS_NRT', days: 1 },
                { product: 'VIIRS_SNPP_NRT', days: 2 },
            ];
            let stats = { total: 0, highConfidence: 0 };
            for (const attempt of attempts) {
                const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(nasaApiKey)}/${attempt.product}/${area}/${attempt.days}`;
                const response = await axios_1.default.get(url, { timeout: 15000 });
                stats = this.parseFireStats(response.data);
                if (stats.total > 0)
                    break;
            }
            await cacheService_1.default.set(cacheKey, stats, CACHE_TTL);
            return stats;
        }
        catch (error) {
            throw new Error(`NASA thermal count unavailable: ${error.message}`);
        }
    }
    // High confidence = VIIRS 'h' or a numeric MODIS confidence >= 80 — same
    // tiering the Flutter client uses (fire_api_service.dart _confidenceRank),
    // kept consistent so "high confidence" means the same thing everywhere.
    parseFireStats(csv) {
        const lines = csv.trim().split(/\r?\n/);
        if (lines.length <= 1)
            return { total: 0, highConfidence: 0 };
        const header = lines[0].split(',');
        const confidenceIdx = header.indexOf('confidence');
        let highConfidence = 0;
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            const raw = (confidenceIdx >= 0 ? cols[confidenceIdx] : '')?.trim().toLowerCase() ?? '';
            const numeric = Number(raw);
            if (raw !== '' && !Number.isNaN(numeric)) {
                if (numeric >= 80)
                    highConfidence++;
            }
            else if (raw === 'h') {
                highConfidence++;
            }
        }
        return { total: lines.length - 1, highConfidence };
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
    async maybeSendRiskAlert(region, risk) {
        if (risk.score < RISK_ALERT_THRESHOLD)
            return;
        const cacheKey = `notif:region:${region.name}`;
        if (await cacheService_1.default.get(cacheKey))
            return;
        const tokens = await this.getActiveTokensNearRegion(region);
        if (tokens.length === 0)
            return;
        await notificationService_1.default.sendToTokens(tokens, `🔥 Yüksek Yangın Riski - ${region.display}`, `Risk skoru: ${risk.score}/100. Sıcaklık yüksek, nem düşük. Dikkatli olun.`);
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
        await notificationService_1.default.sendToTokens(tokens, '🚨 Kritik: Çoklu Yangın Tespiti', `${highConfidenceCount} yüksek güvenilirlikli termal nokta tespit edildi - ${region.display}`);
        await cacheService_1.default.set(cacheKey, true, CRITICAL_ALERT_TTL_SECONDS);
    }
    calculateRisk(weather, fireCount) {
        let score = 0;
        if (weather.temperature >= 40)
            score += 30;
        else if (weather.temperature >= 35)
            score += 22;
        else if (weather.temperature >= 30)
            score += 14;
        else if (weather.temperature >= 25)
            score += 7;
        if (weather.humidity <= 20)
            score += 25;
        else if (weather.humidity <= 30)
            score += 20;
        else if (weather.humidity <= 40)
            score += 13;
        else if (weather.humidity <= 50)
            score += 6;
        if (weather.windSpeed >= 50)
            score += 25;
        else if (weather.windSpeed >= 35)
            score += 18;
        else if (weather.windSpeed >= 20)
            score += 11;
        else if (weather.windSpeed >= 10)
            score += 5;
        if (fireCount >= 10)
            score += 20;
        else if (fireCount >= 5)
            score += 15;
        else if (fireCount >= 2)
            score += 10;
        else if (fireCount >= 1)
            score += 5;
        // Heat index bonus: high temperature and low humidity together are a
        // well-established synergistic fire-danger multiplier (the interaction
        // this additive bucket scoring otherwise misses — e.g. Fosberg Fire
        // Weather Index combines temp/humidity/wind non-linearly rather than
        // just summing independent thresholds). Tiers are mutually exclusive;
        // only the higher one applies.
        if (weather.temperature > 40 && weather.humidity < 20) {
            score += 20;
        }
        else if (weather.temperature > 35 && weather.humidity < 30) {
            score += 10;
        }
        score = Math.min(100, score);
        // Dryness index: temp and humidity remain the primary drivers, but wind
        // now also contributes — it accelerates fuel drying and moisture loss,
        // not just fire spread once ignited.
        const drynessIndex = Math.min(100, Math.round((weather.temperature / 45) * 50 + ((100 - weather.humidity) / 100) * 35 + (weather.windSpeed / 80) * 15));
        const vegetationPressure = Math.min(100, Math.round((weather.windSpeed / 80) * 50 + (weather.temperature / 45) * 50));
        return {
            score,
            level: this.calculateRiskLevel(score),
            drynessIndex,
            vegetationPressure,
        };
    }
    calculateRiskLevel(score) {
        if (score >= 75)
            return 'Critical';
        if (score >= 50)
            return 'High';
        if (score >= 25)
            return 'Medium';
        return 'Low';
    }
    degToDirection(deg) {
        const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        return directions[Math.round(deg / 45) % 8];
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
