"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RISK_STALE_AFTER_HOURS = exports.RISK_HIGH_INDEX = exports.RISK_LEVELS = void 0;
exports.riskLevelForScore = riskLevelForScore;
exports.riskLevelIndex = riskLevelIndex;
exports.calculateRisk = calculateRisk;
exports.markStaleRisk = markStaleRisk;
exports.RISK_LEVELS = ['Low', 'Medium', 'High', 'Critical'];
function riskLevelForScore(score) {
    if (score >= 75)
        return 'Critical';
    if (score >= 50)
        return 'High';
    if (score >= 25)
        return 'Medium';
    return 'Low';
}
/** 0 Low, 1 Medium, 2 High, 3 Critical. */
function riskLevelIndex(level) {
    return Math.max(0, exports.RISK_LEVELS.indexOf(level));
}
exports.RISK_HIGH_INDEX = riskLevelIndex('High');
function calculateRisk(weather, fireCount) {
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
    return { score, level: riskLevelForScore(score), drynessIndex, vegetationPressure };
}
/** The calculator runs every 3 hours, so this is two missed runs. */
exports.RISK_STALE_AFTER_HOURS = 6;
/** Marks rows whose score is too old to be read as the current risk. */
function markStaleRisk(rows, now = new Date()) {
    const limit = exports.RISK_STALE_AFTER_HOURS * 60 * 60 * 1000;
    return rows.map((row) => {
        const at = new Date(row.created_at).getTime();
        return { ...row, is_stale: Number.isNaN(at) || now.getTime() - at > limit };
    });
}
