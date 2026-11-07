import cron from 'node-cron';
import pool from '../config/database';
import { recordJobRun } from '../services/jobRunRecorder';
import { RETENTION_DAYS, STORED_COORDINATE_DECIMALS } from '../utils/locationPrivacy';

/**
 * Enforces the retention rules in utils/locationPrivacy.ts and the privacy
 * policy, once at startup and every night:
 *
 * 1. Device rows (fcm_tokens) not refreshed for RETENTION_DAYS are deleted.
 *    The app re-registers its token every time it starts, which refreshes
 *    updated_at, so only devices that have not opened the app in 90 days —
 *    in practice mostly uninstalled ones — go. Opening the app again
 *    registers the device afresh.
 * 2. Fire reports older than RETENTION_DAYS are deleted with their photos,
 *    name and phone.
 * 3. Safety nets, normally no-ops because the write paths already do this:
 *    an inactive device keeps no location, and no stored coordinate is
 *    more precise than STORED_COORDINATE_DECIMALS. They catch rows written
 *    by an older deploy or by hand.
 *
 * Everything runs in one transaction so a half-applied sweep never exists.
 */
export interface RetentionStats {
  devicesDeleted: number;
  reportsDeleted: number;
  inactiveLocationsErased: number;
  deviceLocationsRounded: number;
  reportLocationsRounded: number;
}

class PrivacyRetentionJob {
  start() {
    // 04:20 every night, clear of the ingest (:00/:30) and burned-area (03:15) runs.
    cron.schedule('20 4 * * *', async () => {
      await this.run().catch(() => undefined);
    });
    this.run().catch(() => undefined);
  }

  async run(): Promise<RetentionStats> {
    const startedAt = new Date();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const devices = await client.query(
        `DELETE FROM fcm_tokens
         WHERE COALESCE(updated_at, created_at) < NOW() - make_interval(days => $1)`,
        [RETENTION_DAYS]
      );
      const reports = await client.query(
        `DELETE FROM fire_reports
         WHERE created_at < NOW() - make_interval(days => $1)`,
        [RETENTION_DAYS]
      );
      const inactive = await client.query(
        `UPDATE fcm_tokens SET latitude = NULL, longitude = NULL
         WHERE is_active = false AND (latitude IS NOT NULL OR longitude IS NOT NULL)`
      );
      const deviceRounded = await client.query(
        `UPDATE fcm_tokens
         SET latitude = round(latitude, $1), longitude = round(longitude, $1)
         WHERE latitude <> round(latitude, $1) OR longitude <> round(longitude, $1)`,
        [STORED_COORDINATE_DECIMALS]
      );
      const reportRounded = await client.query(
        `UPDATE fire_reports
         SET latitude = round(latitude, $1), longitude = round(longitude, $1)
         WHERE latitude <> round(latitude, $1) OR longitude <> round(longitude, $1)`,
        [STORED_COORDINATE_DECIMALS]
      );

      await client.query('COMMIT');

      const stats: RetentionStats = {
        devicesDeleted: devices.rowCount ?? 0,
        reportsDeleted: reports.rowCount ?? 0,
        inactiveLocationsErased: inactive.rowCount ?? 0,
        deviceLocationsRounded: deviceRounded.rowCount ?? 0,
        reportLocationsRounded: reportRounded.rowCount ?? 0,
      };
      console.log(
        `🔒 Privacy retention: ${stats.devicesDeleted} device(s) and ${stats.reportsDeleted} report(s) ` +
          `older than ${RETENTION_DAYS} days deleted; ${stats.inactiveLocationsErased} inactive location(s) erased; ` +
          `${stats.deviceLocationsRounded + stats.reportLocationsRounded} location(s) rounded`
      );
      await recordJobRun('privacy_retention', startedAt, 'ok', { ...stats });
      return stats;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error('Privacy retention failed:', (error as Error).message);
      await recordJobRun('privacy_retention', startedAt, 'failed', {}, error);
      throw error;
    } finally {
      client.release();
    }
  }
}

export default new PrivacyRetentionJob();
