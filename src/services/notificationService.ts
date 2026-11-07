import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import pool from '../config/database';
import { isDeadTokenError } from '../utils/locationPrivacy';

// Firebase initialization - Base64 env variable'dan oku
try {
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (base64) {
    const serviceAccount = JSON.parse(
      Buffer.from(base64, 'base64').toString('utf-8')
    );

    if (getApps().length === 0) {
      initializeApp({
        credential: cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL,
      });
    }
    console.log('✅ Firebase initialized');
  } else {
    console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT_BASE64 not found - Firebase disabled');
  }
} catch (error) {
  console.error('❌ Firebase initialization error:', error);
}

/** FCM's hard per-call limit for sendEachForMulticast. */
const FCM_MULTICAST_LIMIT = 500;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * A token FCM has declared dead will never deliver again, so the location
 * kept for it has no purpose left: deactivate the row and erase the
 * location. The row itself goes with the 90-day retention sweep
 * (jobs/privacyRetentionJob.ts). Best-effort — a failure here must never
 * fail the send that discovered it.
 */
export async function forgetDeadTokens(tokens: string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  try {
    const result = await pool.query(
      `UPDATE fcm_tokens
       SET is_active = false, latitude = NULL, longitude = NULL
       WHERE token = ANY($1::text[])`,
      [tokens]
    );
    console.log(`🧹 FCM rejected ${tokens.length} dead token(s); ${result.rowCount ?? 0} row(s) deactivated, location erased`);
    return result.rowCount ?? 0;
  } catch (error) {
    console.error('forgetDeadTokens failed:', (error as Error).message);
    return 0;
  }
}

class NotificationService {
  async sendToToken(token: string, title: string, body: string, data?: any): Promise<boolean> {
    try {
      const message = {
        notification: { title, body },
        data: data || {},
        token,
      };
      const response = await getMessaging().send(message);
      console.log('✅ Message sent:', response);
      return true;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (isDeadTokenError(code)) await forgetDeadTokens([token]);
      console.error('❌ Error sending message:', code ?? (error as Error).message);
      return false;
    }
  }

  // FCM caps sendEachForMulticast at 500 tokens per call. Callers used to work
  // around that with `LIMIT 500` on the token query, which silently dropped
  // every device past the 500th. Chunking here fixes it for every caller at
  // once: pass the full token list, all of it gets delivered.
  async sendToTokens(tokens: string[], title: string, body: string, data?: any): Promise<number> {
    const chunks = chunk(tokens, FCM_MULTICAST_LIMIT);
    let successCount = 0;
    let failureCount = 0;
    let failedChunks = 0;
    const deadTokens: string[] = [];

    for (const [index, batch] of chunks.entries()) {
      try {
        const response = await getMessaging().sendEachForMulticast({
          tokens: batch,
          notification: { title, body },
          data: data || {},
        });
        successCount += response.successCount;
        failureCount += response.failureCount;
        response.responses.forEach((r, i) => {
          if (!r.success && isDeadTokenError(r.error?.code)) deadTokens.push(batch[i]);
        });
      } catch (error) {
        // One bad chunk must not abort the remaining ones — a partial send
        // reaches more people than no send at all.
        failedChunks++;
        console.error(
          `❌ Multicast chunk ${index + 1}/${chunks.length} failed:`,
          (error as Error).message
        );
      }
    }

    await forgetDeadTokens(deadTokens);

    console.log(
      `✅ Multicast: ${successCount}/${tokens.length} delivered across ` +
        `${chunks.length} chunk(s) — ${failureCount} rejected by FCM, ` +
        `${failedChunks} chunk(s) errored`
    );
    return successCount;
  }

  async sendToTopic(topic: string, title: string, body: string, data?: any): Promise<boolean> {
    try {
      const message = {
        notification: { title, body },
        data: data || {},
        topic,
      };
      const response = await getMessaging().send(message);
      console.log('✅ Message sent to topic:', response);
      return true;
    } catch (error) {
      console.error('❌ Error sending to topic:', error);
      return false;
    }
  }
}

export default new NotificationService();
