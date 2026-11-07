"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLACE_NOTIFICATION_RETENTION_DAYS = exports.DEAD_TOKEN_GRACE_DAYS = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const database_1 = __importDefault(require("../config/database"));
const jobRunRecorder_1 = require("../services/jobRunRecorder");
const locationPrivacy_1 = require("../utils/locationPrivacy");
const trackedPlaces_1 = require("../services/trackedPlaces");
/** A tracked-places device whose FCM token died this long ago is deleted. */
exports.DEAD_TOKEN_GRACE_DAYS = 7;
/** place_notifications only exist to stop repeat alerts; incidents stop alerting after 12 h. */
exports.PLACE_NOTIFICATION_RETENTION_DAYS = 30;
class PrivacyRetentionJob {
    start() {
        // 04:20 every night, clear of the ingest (:00/:30) and burned-area (03:15) runs.
        node_cron_1.default.schedule('20 4 * * *', async () => {
            await this.run().catch(() => undefined);
        });
        this.run().catch(() => undefined);
    }
    async run() {
        const startedAt = new Date();
        // Checked before the transaction: a missing table would abort it.
        const placesReady = await (0, trackedPlaces_1.trackedPlacesAvailable)(database_1.default);
        const client = await database_1.default.connect();
        try {
            await client.query('BEGIN');
            const devices = await client.query(`DELETE FROM fcm_tokens
         WHERE COALESCE(updated_at, created_at) < NOW() - make_interval(days => $1)`, [locationPrivacy_1.RETENTION_DAYS]);
            const reports = await client.query(`DELETE FROM fire_reports
         WHERE created_at < NOW() - make_interval(days => $1)`, [locationPrivacy_1.RETENTION_DAYS]);
            const inactive = await client.query(`UPDATE fcm_tokens SET latitude = NULL, longitude = NULL
         WHERE is_active = false AND (latitude IS NOT NULL OR longitude IS NOT NULL)`);
            const deviceRounded = await client.query(`UPDATE fcm_tokens
         SET latitude = round(latitude, $1), longitude = round(longitude, $1)
         WHERE latitude <> round(latitude, $1) OR longitude <> round(longitude, $1)`, [locationPrivacy_1.STORED_COORDINATE_DECIMALS]);
            const reportRounded = await client.query(`UPDATE fire_reports
         SET latitude = round(latitude, $1), longitude = round(longitude, $1)
         WHERE latitude <> round(latitude, $1) OR longitude <> round(longitude, $1)`, [locationPrivacy_1.STORED_COORDINATE_DECIMALS]);
            let placeDevices = 0;
            let placeNotifications = 0;
            if (placesReady) {
                placeDevices =
                    (await client.query(`DELETE FROM place_devices
               WHERE last_seen_at < NOW() - make_interval(days => $1)
                  OR (fcm_token IS NULL AND token_invalid_at < NOW() - make_interval(days => $2))`, [locationPrivacy_1.RETENTION_DAYS, exports.DEAD_TOKEN_GRACE_DAYS])).rowCount ?? 0;
                placeNotifications =
                    (await client.query(`DELETE FROM place_notifications WHERE created_at < NOW() - make_interval(days => $1)`, [exports.PLACE_NOTIFICATION_RETENTION_DAYS])).rowCount ?? 0;
            }
            await client.query('COMMIT');
            const stats = {
                devicesDeleted: devices.rowCount ?? 0,
                reportsDeleted: reports.rowCount ?? 0,
                inactiveLocationsErased: inactive.rowCount ?? 0,
                deviceLocationsRounded: deviceRounded.rowCount ?? 0,
                reportLocationsRounded: reportRounded.rowCount ?? 0,
                placeDevicesDeleted: placeDevices,
                placeNotificationsDeleted: placeNotifications,
            };
            console.log(`🔒 Privacy retention: ${stats.devicesDeleted} device(s) and ${stats.reportsDeleted} report(s) ` +
                `older than ${locationPrivacy_1.RETENTION_DAYS} days deleted; ${stats.inactiveLocationsErased} inactive location(s) erased; ` +
                `${stats.deviceLocationsRounded + stats.reportLocationsRounded} location(s) rounded; ` +
                `${stats.placeDevicesDeleted} tracked-place device(s) and ${stats.placeNotificationsDeleted} place alert record(s) deleted`);
            await (0, jobRunRecorder_1.recordJobRun)('privacy_retention', startedAt, 'ok', { ...stats });
            return stats;
        }
        catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            console.error('Privacy retention failed:', error.message);
            await (0, jobRunRecorder_1.recordJobRun)('privacy_retention', startedAt, 'failed', {}, error);
            throw error;
        }
        finally {
            client.release();
        }
    }
}
exports.default = new PrivacyRetentionJob();
