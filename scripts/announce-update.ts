/**
 * One-time note to installs older than a build.
 *
 *   npm run announce:update                       counts only
 *   npm run announce:update -- --send --confirm-count=<count from the first run>
 *
 * Options: --target-build=8  --campaign=release-1.2.0
 */
import pool from '../src/config/database';
import cacheService from '../src/services/cacheService';
import { recordJobRun } from '../src/services/jobRunRecorder';
import notificationService, { forgetDeadTokens } from '../src/services/notificationService';
import { UPDATE_ANNOUNCEMENT, runUpdateAnnouncement } from '../src/services/updateAnnouncement';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

(async () => {
  const startedAt = new Date();
  const confirm = arg('confirm-count');
  const outcome = await runUpdateAnnouncement(
    {
      installs: async () => (await pool.query(`SELECT token, device_name FROM fcm_tokens WHERE is_active = true`)).rows,
      send: (messages) => notificationService.sendMessages(messages),
      forget: async (tokens) => {
        await forgetDeadTokens(tokens);
      },
      alreadySent: async (key) => (await cacheService.get<boolean>(key)) === true,
      markSent: (key, ttl) => cacheService.set(key, true, ttl),
      record: (stats) => recordJobRun('update_announcement', startedAt, 'ok', stats),
      now: () => new Date(),
    },
    {
      send: process.argv.includes('--send'),
      confirmCount: confirm === undefined ? undefined : Number(confirm),
      targetBuild: Number(arg('target-build') ?? 8),
      campaign: arg('campaign') ?? 'release-1.2.0',
    }
  );
  console.log(`Title: ${UPDATE_ANNOUNCEMENT.title}\nBody:  ${UPDATE_ANNOUNCEMENT.body}`);
  console.log(JSON.stringify(outcome));
  process.exit(outcome.mode === 'refused' ? 1 : 0);
})().catch((error) => {
  console.error('Announcement failed:', (error as Error).message);
  process.exit(1);
});
