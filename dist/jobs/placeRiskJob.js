"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RISK_CHECK_MAX_POINTS = exports.RISK_CHECK_INTERVAL_HOURS = exports.RISK_CHECK_LAST_HOUR = exports.RISK_CHECK_FIRST_HOUR = void 0;
exports.turkeyClock = turkeyClock;
exports.shouldAlert = shouldAlert;
exports.dueRiskPlacesSql = dueRiskPlacesSql;
exports.runPlaceRiskAlerts = runPlaceRiskAlerts;
const alertConsent_1 = require("../utils/alertConsent");
const crypto_1 = __importDefault(require("crypto"));
const database_1 = __importDefault(require("../config/database"));
const jobRunRecorder_1 = require("../services/jobRunRecorder");
const notificationService_1 = __importStar(require("../services/notificationService"));
const pointRisk_1 = require("../services/pointRisk");
const weatherSource_1 = require("../services/weatherSource");
const riskScore_1 = require("../services/riskScore");
const trackedPlaces_1 = require("../services/trackedPlaces");
/**
 * Per-place risk alerts ("Yerlerim"). Runs in the ingest tick, right after
 * the heat alerts, so it works whenever the service is awake.
 *
 * Each place with its switch on is checked every RISK_CHECK_INTERVAL_HOURS
 * during waking hours, with the same score the app shows for that point
 * (services/pointRisk.ts). An alert goes out when the level is High or
 * Critical and has risen (or is unknown from before), at most once per
 * Turkish calendar day: a level that merely stays High does not repeat. One
 * push per device per run, naming the worst place.
 */
exports.RISK_CHECK_FIRST_HOUR = 7;
exports.RISK_CHECK_LAST_HOUR = 20;
/** The score follows the weather, so one morning check would miss the afternoon. */
exports.RISK_CHECK_INTERVAL_HOURS = 3;
/** Upper bound per tick, to stay polite to the weather services. */
exports.RISK_CHECK_MAX_POINTS = 60;
/** Turkish calendar date and hour, whatever the server's time zone is. */
function turkeyClock(now) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Istanbul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type).value;
    return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}
/** The rule in one place: High or above, risen, not already told today. */
function shouldAlert(previous, current, lastNotifiedOn, today) {
    if (current < riskScore_1.RISK_HIGH_INDEX)
        return false;
    if (lastNotifiedOn === today)
        return false;
    return previous === null || previous < riskScore_1.RISK_HIGH_INDEX || current > previous;
}
function dueRiskPlacesSql() {
    return `SELECT p.id AS place_id, p.install_id, p.name AS place_name, p.latitude, p.longitude,
                 d.fcm_token, d.locale, s.last_class,
                 to_char(s.last_notified_on, 'YYYY-MM-DD') AS last_notified_on
            FROM tracked_places p
            JOIN place_devices d ON d.install_id = p.install_id
            LEFT JOIN place_risk_state s ON s.place_id = p.id
           WHERE p.notify_risk
             AND ${(0, alertConsent_1.deviceNotMutedSql)('d')}
             AND (s.last_checked_at IS NULL
                  OR s.last_checked_at <= $1::timestamptz - make_interval(hours => $2))
           ORDER BY s.last_checked_at NULLS FIRST
           LIMIT 300`;
}
async function saveState(db, placeId, cls, today, notified, at) {
    await db.query(`INSERT INTO place_risk_state (place_id, last_class, last_checked_on, last_notified_on, last_checked_at)
     VALUES ($1, $2, $3::date, CASE WHEN $4 THEN $3::date END, $5::timestamptz)
     ON CONFLICT (place_id) DO UPDATE SET
       last_class = EXCLUDED.last_class,
       last_checked_on = EXCLUDED.last_checked_on,
       last_checked_at = EXCLUDED.last_checked_at,
       last_notified_on = COALESCE(EXCLUDED.last_notified_on, place_risk_state.last_notified_on),
       updated_at = NOW()`, [placeId, cls, today, notified, at]);
}
async function runPlaceRiskAlerts(db, send, sample, now = new Date(), opts = {}) {
    const stats = { skipped: false, checked: 0, pushesSent: 0, failed: 0, sampleErrors: 0 };
    const { date, hour } = turkeyClock(now);
    if (hour < exports.RISK_CHECK_FIRST_HOUR || hour > exports.RISK_CHECK_LAST_HOUR)
        return { ...stats, skipped: true };
    const { rows } = await db.query(dueRiskPlacesSql(), [now, exports.RISK_CHECK_INTERVAL_HOURS]);
    // One weather request for every due point, so the loop below reads the cache.
    if (opts.prepare) {
        const unique = new Map();
        for (const row of rows) {
            const lat = (0, pointRisk_1.roundToPointGrid)(Number(row.latitude));
            const lng = (0, pointRisk_1.roundToPointGrid)(Number(row.longitude));
            if (unique.size < exports.RISK_CHECK_MAX_POINTS)
                unique.set(`${lat},${lng}`, { lat, lng });
        }
        await opts.prepare([...unique.values()]).catch(() => undefined);
    }
    // The score is computed on a coarse grid, so neighbours share one reading.
    const samples = new Map();
    const candidates = new Map();
    for (const row of rows) {
        const key = `${(0, pointRisk_1.roundToPointGrid)(Number(row.latitude))},${(0, pointRisk_1.roundToPointGrid)(Number(row.longitude))}`;
        if (!samples.has(key)) {
            if (samples.size >= exports.RISK_CHECK_MAX_POINTS)
                continue;
            try {
                samples.set(key, await sample(Number(row.latitude), Number(row.longitude)));
            }
            catch {
                samples.set(key, 'error');
                stats.sampleErrors++;
            }
        }
        const reading = samples.get(key);
        // A failed reading is retried next tick: no state is written.
        if (reading === 'error')
            continue;
        stats.checked++;
        if (shouldAlert(row.last_class, reading.level, row.last_notified_on, date) && row.fcm_token) {
            const list = candidates.get(row.install_id) ?? [];
            list.push({ row, reading });
            candidates.set(row.install_id, list);
        }
        else {
            await saveState(db, row.place_id, reading.level, date, false, now);
        }
    }
    const devices = [...candidates.values()].map((list) => [...list].sort((a, b) => b.reading.score - a.reading.score));
    if (devices.length === 0)
        return stats;
    const messages = devices.map((list) => {
        const worst = list[0];
        const locale = worst.row.locale === 'en' ? 'en' : 'tr';
        const text = (0, trackedPlaces_1.buildRiskAlertText)(locale, worst.row.place_name, worst.reading.level, worst.reading.score, list.length - 1);
        return {
            token: worst.row.fcm_token,
            title: text.title,
            body: text.body,
            data: { type: 'place_heat_summary', count: String(list.length), push_id: crypto_1.default.randomUUID() },
            androidChannelId: trackedPlaces_1.PLACES_ANDROID_CHANNEL,
            tag: `place-risk-${date}`,
            ttlSeconds: trackedPlaces_1.HEAT_ALERT_TTL_SECONDS,
        };
    });
    const results = await send(messages);
    const deadTokens = [];
    for (let i = 0; i < devices.length; i++) {
        const result = results[i];
        if (result?.success) {
            stats.pushesSent++;
            for (const { row, reading } of devices[i])
                await saveState(db, row.place_id, reading.level, date, true, now);
        }
        else {
            stats.failed++;
            if (result?.deadToken)
                deadTokens.push(devices[i][0].row.fcm_token);
            // Not recorded as checked, so a transient failure is retried next tick.
        }
    }
    if (deadTokens.length > 0) {
        await db.query(`UPDATE place_devices SET fcm_token = NULL, token_invalid_at = NOW() WHERE fcm_token = ANY($1::text[])`, [deadTokens]);
        if (opts.forgetFcmTokens !== false)
            await (0, notificationService_1.forgetDeadTokens)(deadTokens);
    }
    return stats;
}
class PlaceRiskJob {
    async run() {
        const startedAt = new Date();
        const empty = { skipped: true, checked: 0, pushesSent: 0, failed: 0, sampleErrors: 0 };
        if (!(await (0, trackedPlaces_1.trackedPlacesAvailable)(database_1.default)))
            return empty;
        try {
            const deps = (0, pointRisk_1.defaultPointRiskDeps)(database_1.default, 'places');
            const stats = await runPlaceRiskAlerts(database_1.default, (m) => notificationService_1.default.sendMessages(m), async (lat, lng) => {
                const risk = await (0, pointRisk_1.computePointRisk)(lat, lng, deps);
                return { level: (0, riskScore_1.riskLevelIndex)(risk.risk_level), score: risk.general_risk_score };
            }, new Date(), { prepare: (points) => weatherSource_1.weatherSource.readMany(points, 'places') });
            if (!stats.skipped && (stats.checked > 0 || stats.sampleErrors > 0)) {
                await (0, jobRunRecorder_1.recordJobRun)('place_risk', startedAt, 'ok', { ...stats });
            }
            return stats;
        }
        catch (error) {
            console.error('Place risk alerts failed:', error.message);
            await (0, jobRunRecorder_1.recordJobRun)('place_risk', startedAt, 'failed', {}, error);
            return empty;
        }
    }
}
exports.default = new PlaceRiskJob();
