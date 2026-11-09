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
exports.dropHeldOfMutedSql = dropHeldOfMutedSql;
exports.dueSummariesSql = dueSummariesSql;
exports.newHeatPairsSql = newHeatPairsSql;
exports.planDevicePushes = planDevicePushes;
exports.buildPushMessage = buildPushMessage;
exports.buildSummaryMessage = buildSummaryMessage;
exports.runPlaceAlerts = runPlaceAlerts;
const alertConsent_1 = require("../utils/alertConsent");
const crypto_1 = __importDefault(require("crypto"));
const database_1 = __importDefault(require("../config/database"));
const jobRunRecorder_1 = require("../services/jobRunRecorder");
const heatSource_1 = require("../services/heatSource");
const landCover_1 = require("../services/landCover");
const notificationService_1 = __importStar(require("../services/notificationService"));
const trackedPlaces_1 = require("../services/trackedPlaces");
const RECENT_PUSHES_SQL = (installIdExpr) => `
  (SELECT count(DISTINCT x.push_id)::int FROM place_notifications x
    WHERE x.install_id = ${installIdExpr} AND x.push_id IS NOT NULL
      AND x.pushed_at > NOW() - make_interval(hours => ${trackedPlaces_1.HEAT_ALERT_CAP_WINDOW_HOURS}))`;
/** Held detections must not arrive as a late summary after alerts come back on. */
function dropHeldOfMutedSql() {
    return `
    UPDATE place_notifications n SET status = 'undeliverable'
    FROM place_devices d
    WHERE n.status = 'held' AND d.install_id = n.install_id AND NOT ${(0, alertConsent_1.deviceNotMutedSql)('d')}
  `;
}
/** Devices whose held detections are due a summary (cap window over). */
function dueSummariesSql() {
    return `
    SELECT d.install_id, d.fcm_token, d.locale, count(DISTINCT n.ref_key)::int AS held_detections
    FROM place_notifications n
    JOIN place_devices d ON d.install_id = n.install_id
    WHERE n.status = 'held'
      AND ${RECENT_PUSHES_SQL('d.install_id')} < ${trackedPlaces_1.HEAT_ALERT_DEVICE_CAP}
    GROUP BY d.install_id, d.fcm_token, d.locale
  `;
}
/** Records and returns the new (place, incident) pairs of this run. */
function newHeatPairsSql() {
    const tiers = trackedPlaces_1.HEAT_ALERT_MIN_TIERS.map((t) => `'${t}'`).join(', ');
    return `
    WITH candidates AS (
      SELECT p.id AS place_id, p.install_id, i.id AS incident_id
      FROM tracked_places p
      JOIN place_devices d ON d.install_id = p.install_id
      JOIN fire_incidents i
        ON ST_DWithin(p.geom, i.centroid::geography, p.radius_m)
      WHERE p.notify_heat
        AND ${(0, alertConsent_1.deviceNotMutedSql)('d')}
        AND i.last_detected_at > NOW() - make_interval(hours => ${trackedPlaces_1.HEAT_ALERT_MAX_AGE_HOURS})
        AND i.peak_confidence_tier IN (${tiers})
        AND NOT COALESCE((${(0, heatSource_1.heatSourceSqlCondition)('i')}), false)
        AND ${(0, landCover_1.naturalOrConfirmedSql)('i')}
    ),
    inserted AS (
      INSERT INTO place_notifications (place_id, kind, ref_key, install_id, status)
      SELECT place_id, 'heat', incident_id::text, install_id, 'new' FROM candidates
      ON CONFLICT (place_id, kind, ref_key) DO NOTHING
      RETURNING place_id, ref_key, install_id
    )
    SELECT ins.place_id, ins.install_id, ins.ref_key AS incident_id,
           p.name AS place_name,
           ST_Distance(p.geom, i.centroid::geography) AS distance_m,
           round(ST_Y(i.centroid)::numeric, 4)::float AS incident_lat,
           round(ST_X(i.centroid)::numeric, 4)::float AS incident_lng,
           d.fcm_token, d.locale,
           ${RECENT_PUSHES_SQL('ins.install_id')} AS recent_pushes
    FROM inserted ins
    JOIN tracked_places p ON p.id = ins.place_id
    JOIN place_devices d ON d.install_id = ins.install_id
    JOIN fire_incidents i ON i.id = ins.ref_key::bigint
  `;
}
/** Pure: new pairs → at most one push per device, honouring the cap. */
function planDevicePushes(pairs) {
    const byDevice = new Map();
    for (const pair of pairs) {
        const list = byDevice.get(pair.install_id) ?? [];
        list.push(pair);
        byDevice.set(pair.install_id, list);
    }
    const plan = { pushes: [], held: [], undeliverable: [] };
    for (const [installId, list] of byDevice) {
        const first = list[0];
        if (!first.fcm_token) {
            plan.undeliverable.push(...list);
            continue;
        }
        if (first.recent_pushes >= trackedPlaces_1.HEAT_ALERT_DEVICE_CAP) {
            plan.held.push(...list);
            continue;
        }
        const sorted = [...list].sort((a, b) => Number(a.distance_m) - Number(b.distance_m));
        // Distinct incidents beyond the one named: two places seeing the same
        // fire are still one fire.
        const incidents = new Set(list.map((p) => p.incident_id));
        plan.pushes.push({
            installId,
            token: first.fcm_token,
            locale: first.locale === 'en' ? 'en' : 'tr',
            nearest: sorted[0],
            extra: incidents.size - 1,
            pairs: list,
        });
    }
    return plan;
}
function buildPushMessage(push) {
    const text = (0, trackedPlaces_1.buildHeatAlertText)(push.locale, push.nearest.place_name, Number(push.nearest.distance_m), push.extra);
    return {
        token: push.token,
        title: text.title,
        body: text.body,
        data: {
            type: 'place_heat',
            place_id: push.nearest.place_id,
            incident_id: String(push.nearest.incident_id),
            lat: String(push.nearest.incident_lat),
            lng: String(push.nearest.incident_lng),
        },
        androidChannelId: trackedPlaces_1.PLACES_ANDROID_CHANNEL,
        // Same incident → same tag, so a resend can never stack two banners.
        tag: `incident-${push.nearest.incident_id}`,
        ttlSeconds: trackedPlaces_1.HEAT_ALERT_TTL_SECONDS,
    };
}
function buildSummaryMessage(device) {
    const text = (0, trackedPlaces_1.buildHeatSummaryText)(device.locale === 'en' ? 'en' : 'tr', device.held_detections);
    return {
        token: device.fcm_token,
        title: text.title,
        body: text.body,
        data: { type: 'place_heat_summary', count: String(device.held_detections) },
        androidChannelId: trackedPlaces_1.PLACES_ANDROID_CHANNEL,
        tag: 'places-summary',
        ttlSeconds: trackedPlaces_1.HEAT_ALERT_TTL_SECONDS,
    };
}
async function setStatus(db, pairs, status) {
    if (pairs.length === 0)
        return;
    await db.query(`UPDATE place_notifications SET status = $1
     WHERE kind = 'heat' AND (place_id, ref_key) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))`, [status, pairs.map((p) => p.place_id), pairs.map((p) => String(p.incident_id))]);
}
async function markPushed(db, pairs, pushId) {
    await db.query(`UPDATE place_notifications SET status = 'sent', push_id = $1, pushed_at = NOW()
     WHERE kind = 'heat' AND (place_id, ref_key) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))`, [pushId, pairs.map((p) => p.place_id), pairs.map((p) => String(p.incident_id))]);
}
async function clearDeadTokens(db, tokens, alsoFcmTokens) {
    if (tokens.length === 0)
        return;
    await db.query(`UPDATE place_devices SET fcm_token = NULL, token_invalid_at = NOW() WHERE fcm_token = ANY($1::text[])`, [tokens]);
    // The same token may also be on fcm_tokens; it is just as dead there.
    if (alsoFcmTokens)
        await (0, notificationService_1.forgetDeadTokens)(tokens);
}
/**
 * One full pass over [db] with [send]. Exported for the PostGIS test, which
 * runs it on a rolled-back transaction with a fake sender.
 */
async function runPlaceAlerts(db, send, opts = {}) {
    const stats = {
        skipped: false, newPairs: 0, pushesSent: 0, summariesSent: 0, held: 0, undeliverable: 0, failed: 0, deadTokens: 0,
    };
    const forget = opts.forgetFcmTokens ?? true;
    await db.query(dropHeldOfMutedSql());
    // 1. Summaries for devices whose cap window has ended.
    const due = (await db.query(dueSummariesSql())).rows;
    const noToken = due.filter((d) => !d.fcm_token);
    if (noToken.length > 0) {
        await db.query(`UPDATE place_notifications SET status = 'undeliverable'
       WHERE status = 'held' AND install_id = ANY($1::uuid[])`, [noToken.map((d) => d.install_id)]);
        stats.undeliverable += noToken.length;
    }
    const summaries = due.filter((d) => d.fcm_token);
    if (summaries.length > 0) {
        const results = await send(summaries.map(buildSummaryMessage));
        const dead = [];
        for (const [i, r] of results.entries()) {
            const device = summaries[i];
            if (r.success) {
                await db.query(`UPDATE place_notifications SET status = 'summarized', push_id = $2, pushed_at = NOW()
           WHERE status = 'held' AND install_id = $1`, [device.install_id, crypto_1.default.randomUUID()]);
                stats.summariesSent++;
            }
            else if (r.deadToken) {
                dead.push(device.fcm_token);
                await db.query(`UPDATE place_notifications SET status = 'undeliverable' WHERE status = 'held' AND install_id = $1`, [device.install_id]);
            }
            else {
                stats.failed++; // stays held; the next run tries again
            }
        }
        stats.deadTokens += dead.length;
        await clearDeadTokens(db, dead, forget);
    }
    // 2. New pairs.
    const pairs = (await db.query(newHeatPairsSql())).rows;
    stats.newPairs = pairs.length;
    if (pairs.length === 0)
        return stats;
    const plan = planDevicePushes(pairs);
    await setStatus(db, plan.held, 'held');
    await setStatus(db, plan.undeliverable, 'undeliverable');
    stats.held += plan.held.length;
    stats.undeliverable += plan.undeliverable.length;
    if (plan.pushes.length > 0) {
        const results = await send(plan.pushes.map(buildPushMessage));
        const dead = [];
        for (const [i, r] of results.entries()) {
            const push = plan.pushes[i];
            if (r.success) {
                await markPushed(db, push.pairs, crypto_1.default.randomUUID());
                stats.pushesSent++;
            }
            else if (r.deadToken) {
                dead.push(push.token);
                await setStatus(db, push.pairs, 'undeliverable');
            }
            else {
                // A transient failure must not lose them: they go out in a summary.
                await setStatus(db, push.pairs, 'held');
                stats.failed++;
            }
        }
        stats.deadTokens += dead.length;
        await clearDeadTokens(db, dead, forget);
    }
    return stats;
}
class PlaceAlertJob {
    async run() {
        const startedAt = new Date();
        if (!(await (0, trackedPlaces_1.trackedPlacesAvailable)(database_1.default))) {
            // Migration 014 not applied: nothing to do, nothing to record.
            return { skipped: true, newPairs: 0, pushesSent: 0, summariesSent: 0, held: 0, undeliverable: 0, failed: 0, deadTokens: 0 };
        }
        try {
            const stats = await runPlaceAlerts(database_1.default, (m) => notificationService_1.default.sendMessages(m));
            if (stats.newPairs > 0 || stats.summariesSent > 0 || stats.failed > 0) {
                console.log(`📍 Place alerts: ${stats.newPairs} new pair(s), ${stats.pushesSent} push(es), ${stats.summariesSent} summary(ies), ` +
                    `${stats.held} held, ${stats.undeliverable} undeliverable, ${stats.failed} failed, ${stats.deadTokens} dead token(s)`);
            }
            await (0, jobRunRecorder_1.recordJobRun)('place_alerts', startedAt, 'ok', { ...stats });
            return stats;
        }
        catch (error) {
            console.error('Place alerts failed:', error.message);
            await (0, jobRunRecorder_1.recordJobRun)('place_alerts', startedAt, 'failed', {}, error);
            return { skipped: false, newPairs: 0, pushesSent: 0, summariesSent: 0, held: 0, undeliverable: 0, failed: 0, deadTokens: 0 };
        }
    }
}
exports.default = new PlaceAlertJob();
