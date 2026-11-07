"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const database_1 = __importDefault(require("../config/database"));
const jobRunRecorder_1 = require("../services/jobRunRecorder");
const locationPrivacy_1 = require("../utils/locationPrivacy");
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
            await client.query('COMMIT');
            const stats = {
                devicesDeleted: devices.rowCount ?? 0,
                reportsDeleted: reports.rowCount ?? 0,
                inactiveLocationsErased: inactive.rowCount ?? 0,
                deviceLocationsRounded: deviceRounded.rowCount ?? 0,
                reportLocationsRounded: reportRounded.rowCount ?? 0,
            };
            console.log(`🔒 Privacy retention: ${stats.devicesDeleted} device(s) and ${stats.reportsDeleted} report(s) ` +
                `older than ${locationPrivacy_1.RETENTION_DAYS} days deleted; ${stats.inactiveLocationsErased} inactive location(s) erased; ` +
                `${stats.deviceLocationsRounded + stats.reportLocationsRounded} location(s) rounded`);
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
