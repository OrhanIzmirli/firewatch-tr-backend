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
exports.newHeatPairsSql = newHeatPairsSql;
exports.planDevicePushes = planDevicePushes;
exports.buildPushMessage = buildPushMessage;
const database_1 = __importDefault(require("../config/database"));
const jobRunRecorder_1 = require("../services/jobRunRecorder");
const heatSource_1 = require("../services/heatSource");
const notificationService_1 = __importStar(require("../services/notificationService"));
const trackedPlaces_1 = require("../services/trackedPlaces");
/**
 * The candidate query. Kept as an exported builder so the test can check its
 * shape without a database.
 */
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
        AND i.last_detected_at > NOW() - make_interval(hours => ${trackedPlaces_1.HEAT_ALERT_MAX_AGE_HOURS})
        AND i.peak_confidence_tier IN (${tiers})
        AND NOT COALESCE((${(0, heatSource_1.heatSourceSqlCondition)('i')}), false)
    ),
    inserted AS (
      INSERT INTO place_notifications (place_id, kind, ref_key, install_id, delivered)
      SELECT place_id, 'heat', incident_id::text, install_id, false FROM candidates
      ON CONFLICT (place_id, kind, ref_key) DO NOTHING
      RETURNING place_id, ref_key, install_id
    )
    SELECT ins.place_id, ins.install_id, ins.ref_key AS incident_id,
           p.name AS place_name,
           ST_Distance(p.geom, i.centroid::geography) AS distance_m,
           d.fcm_token, d.locale,
           (SELECT count(*)::int FROM place_notifications n
             WHERE n.install_id = ins.install_id AND n.delivered
               AND n.created_at > NOW() - make_interval(hours => ${trackedPlaces_1.HEAT_ALERT_CAP_WINDOW_HOURS})) AS recent_delivered
    FROM inserted ins
    JOIN tracked_places p ON p.id = ins.place_id
    JOIN place_devices d ON d.install_id = ins.install_id
    JOIN fire_incidents i ON i.id = ins.ref_key::bigint
  `;
}
/**
 * Pure: turns the new pairs into at most one push per device, honouring the
 * cap. Devices without a live token, or at the cap, get nothing.
 */
function planDevicePushes(pairs) {
    const byDevice = new Map();
    for (const pair of pairs) {
        const list = byDevice.get(pair.install_id) ?? [];
        list.push(pair);
        byDevice.set(pair.install_id, list);
    }
    const pushes = [];
    let capped = 0;
    for (const [installId, list] of byDevice) {
        const first = list[0];
        if (!first.fcm_token)
            continue;
        if (first.recent_delivered >= trackedPlaces_1.HEAT_ALERT_DEVICE_CAP) {
            capped++;
            continue;
        }
        const sorted = [...list].sort((a, b) => Number(a.distance_m) - Number(b.distance_m));
        // Distinct incidents beyond the one named: two places seeing the same
        // fire are still one fire.
        const incidents = new Set(list.map((p) => p.incident_id));
        pushes.push({
            installId,
            token: first.fcm_token,
            locale: first.locale === 'en' ? 'en' : 'tr',
            nearest: sorted[0],
            extra: incidents.size - 1,
        });
    }
    return { pushes, capped };
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
        },
        androidChannelId: trackedPlaces_1.PLACES_ANDROID_CHANNEL,
        // Same incident → same tag, so a resend can never stack two banners.
        tag: `incident-${push.nearest.incident_id}`,
        ttlSeconds: trackedPlaces_1.HEAT_ALERT_TTL_SECONDS,
    };
}
class PlaceAlertJob {
    async run() {
        const startedAt = new Date();
        const stats = {
            skipped: false, newPairs: 0, devicesNotified: 0, devicesCapped: 0, delivered: 0, failed: 0, deadTokens: 0,
        };
        if (!(await (0, trackedPlaces_1.trackedPlacesAvailable)(database_1.default))) {
            stats.skipped = true;
            return stats; // migration 014 not applied: nothing to do, nothing to record
        }
        try {
            const result = await database_1.default.query(newHeatPairsSql());
            const pairs = result.rows;
            stats.newPairs = pairs.length;
            if (pairs.length === 0) {
                await (0, jobRunRecorder_1.recordJobRun)('place_alerts', startedAt, 'ok', { ...stats });
                return stats;
            }
            const { pushes, capped } = planDevicePushes(pairs);
            stats.devicesCapped = capped;
            const results = await notificationService_1.default.sendMessages(pushes.map(buildPushMessage));
            const deliveredDevices = [];
            const deadTokens = [];
            results.forEach((r, i) => {
                if (r.success)
                    deliveredDevices.push(pushes[i].installId);
                else if (r.deadToken)
                    deadTokens.push(pushes[i].token);
            });
            stats.devicesNotified = deliveredDevices.length;
            stats.failed = results.length - deliveredDevices.length;
            if (deliveredDevices.length > 0) {
                // Every new pair of a notified device counts as delivered (they
                // were all folded into its one push).
                const marked = await database_1.default.query(`UPDATE place_notifications SET delivered = true
           WHERE kind = 'heat' AND install_id = ANY($1::uuid[])
             AND (place_id, ref_key) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))`, [
                    deliveredDevices,
                    pairs.map((p) => p.place_id),
                    pairs.map((p) => String(p.incident_id)),
                ]);
                stats.delivered = marked.rowCount ?? 0;
            }
            if (deadTokens.length > 0) {
                stats.deadTokens = deadTokens.length;
                await database_1.default.query(`UPDATE place_devices SET fcm_token = NULL, token_invalid_at = NOW()
           WHERE fcm_token = ANY($1::text[])`, [deadTokens]);
                // The same token may also be on fcm_tokens; it is just as dead there.
                await (0, notificationService_1.forgetDeadTokens)(deadTokens);
            }
            console.log(`📍 Place alerts: ${stats.newPairs} new place/incident pair(s), ${stats.devicesNotified} device(s) notified, ` +
                `${stats.devicesCapped} at the cap, ${stats.failed} failed, ${stats.deadTokens} dead token(s)`);
            await (0, jobRunRecorder_1.recordJobRun)('place_alerts', startedAt, 'ok', { ...stats });
            return stats;
        }
        catch (error) {
            console.error('Place alerts failed:', error.message);
            await (0, jobRunRecorder_1.recordJobRun)('place_alerts', startedAt, 'failed', { ...stats }, error);
            return stats;
        }
    }
}
exports.default = new PlaceAlertJob();
