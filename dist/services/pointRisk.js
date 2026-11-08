"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.POINT_RISK_CACHE_SECONDS = exports.NEARBY_RISK_RADIUS_KM = void 0;
exports.roundToPointGrid = roundToPointGrid;
exports.nearbyIncidentCountSql = nearbyIncidentCountSql;
exports.loadNearbyIncidentCount = loadNearbyIncidentCount;
exports.defaultPointRiskDeps = defaultPointRiskDeps;
exports.computePointRisk = computePointRisk;
const cacheService_1 = __importDefault(require("./cacheService"));
const heatSource_1 = require("./heatSource");
const detectionStatus_1 = require("./detectionStatus");
const nearbyFireCount_1 = require("./nearbyFireCount");
const provinces_1 = require("./provinces");
const riskScore_1 = require("./riskScore");
const weatherProviders_1 = require("./weatherProviders");
/**
 * The FireWatch risk score at one point: "Konumum", a saved place, and the
 * alert for a saved place. Same formula as the regions (services/riskScore.ts);
 * only the inputs are local: the weather at the point and the satellite
 * events within NEARBY_RISK_RADIUS_KM of it in the last 24 hours.
 *
 * The radius is fixed, not the place's alert radius, so changing how far a
 * place's alerts reach cannot change its risk score.
 *
 * Privacy: the point is rounded to about 10 km (0.1 degree) before anything
 * is done with it. That is what goes to the weather services and what the
 * short-lived cache is keyed by; nothing here is written to the database.
 */
exports.NEARBY_RISK_RADIUS_KM = 50;
exports.POINT_RISK_CACHE_SECONDS = 15 * 60;
function roundToPointGrid(value) {
    return Math.round(value * 10) / 10;
}
function nearbyIncidentCountSql() {
    return `SELECT count(*)::int AS n
            FROM fire_incidents i
           WHERE i.last_detected_at > now() - make_interval(hours => $3)
             AND ST_DWithin(
                   i.centroid::geography,
                   ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                   $4
                 )
             AND NOT COALESCE((${(0, heatSource_1.heatSourceSqlCondition)('i')}), false)`;
}
/** Events near the point, or null when the pipeline cannot vouch for them. */
async function loadNearbyIncidentCount(db, lat, lng) {
    try {
        if (!(await (0, detectionStatus_1.loadPipelineState)(db)).fresh)
            return null;
        const result = await db.query(nearbyIncidentCountSql(), [
            lng,
            lat,
            nearbyFireCount_1.NEARBY_FIRE_WINDOW_HOURS,
            exports.NEARBY_RISK_RADIUS_KM * 1000,
        ]);
        return Number(result.rows[0].n);
    }
    catch (error) {
        console.error('point risk: nearby count unavailable:', error.message);
        return null;
    }
}
function defaultPointRiskDeps(db) {
    return {
        weather: async (lat, lng) => (await (0, weatherProviders_1.fetchWeatherWithFallback)(lat, lng)).weather,
        nearby: (lat, lng) => loadNearbyIncidentCount(db, lat, lng),
        province: (lat, lng) => (0, provinces_1.resolveProvince)(db, lat, lng),
        cache: cacheService_1.default,
        now: () => new Date(),
    };
}
/** Throws when the weather cannot be read: a score needs its weather. */
async function computePointRisk(rawLat, rawLng, deps) {
    const lat = roundToPointGrid(rawLat);
    const lng = roundToPointGrid(rawLng);
    const key = `risk:point:v1:${lat}:${lng}`;
    const cached = await deps.cache.get(key);
    if (cached)
        return cached;
    const [weather, nearby, province] = await Promise.all([
        deps.weather(lat, lng),
        deps.nearby(lat, lng),
        deps.province(lat, lng).catch(() => null),
    ]);
    const risk = (0, riskScore_1.calculateRisk)(weather, nearby ?? 0);
    const result = {
        latitude: lat,
        longitude: lng,
        city: province?.name ?? null,
        region: province?.region ?? null,
        general_risk_score: risk.score,
        risk_level: risk.level,
        temperature: weather.temperature,
        humidity: weather.humidity,
        wind_speed: weather.windSpeed,
        wind_direction: weather.windDirection,
        dryness_index: risk.drynessIndex,
        vegetation_density: risk.vegetationPressure,
        nearby_fire_count: nearby,
        nearby_radius_km: exports.NEARBY_RISK_RADIUS_KM,
        date: deps.now().toISOString(),
    };
    await deps.cache.set(key, result, exports.POINT_RISK_CACHE_SECONDS);
    return result;
}
