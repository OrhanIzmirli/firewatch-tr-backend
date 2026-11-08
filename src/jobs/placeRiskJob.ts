import crypto from 'crypto';
import pool from '../config/database';
import { recordJobRun } from '../services/jobRunRecorder';
import notificationService, { forgetDeadTokens, PushMessage, PushResult } from '../services/notificationService';
import { FWI_HIGH_CLASS, sampleFwiClass } from '../services/fwiPoint';
import {
  HEAT_ALERT_TTL_SECONDS,
  Locale,
  PLACES_ANDROID_CHANNEL,
  buildRiskAlertText,
  trackedPlacesAvailable,
} from '../services/trackedPlaces';

/**
 * Per-place fire-danger alerts ("Yerlerim"). Runs in the ingest tick, right
 * after the heat alerts, so it works whenever the service is awake.
 *
 * Each place with its switch on is checked once per Turkish calendar day,
 * during waking hours. An alert goes out when the day's FWI class is High or
 * above and has risen (or is unknown from before): a level that merely stays
 * High does not repeat. One push per device per run, naming the worst place.
 */

export const RISK_CHECK_FIRST_HOUR = 7;
export const RISK_CHECK_LAST_HOUR = 20;
/** Upper bound per tick, to stay polite to the Copernicus map server. */
export const RISK_CHECK_MAX_POINTS = 60;

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export type Sender = (messages: PushMessage[]) => Promise<PushResult[]>;
export type Sampler = (lat: number, lng: number, date: string) => Promise<number | null>;

export interface PlaceRiskStats {
  skipped: boolean;
  checked: number;
  pushesSent: number;
  failed: number;
  sampleErrors: number;
}

export interface RiskRow {
  place_id: string;
  install_id: string;
  place_name: string;
  latitude: string | number;
  longitude: string | number;
  fcm_token: string | null;
  locale: string;
  last_class: number | null;
  last_notified_on: string | null;
}

/** Turkish calendar date and hour, whatever the server's time zone is. */
export function turkeyClock(now: Date): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

/** The rule in one place: High or above, risen, not already told today. */
export function shouldAlert(previous: number | null, current: number | null, lastNotifiedOn: string | null, today: string): boolean {
  if (current === null || current < FWI_HIGH_CLASS) return false;
  if (lastNotifiedOn === today) return false;
  return previous === null || previous < FWI_HIGH_CLASS || current > previous;
}

export function dueRiskPlacesSql(): string {
  return `SELECT p.id AS place_id, p.install_id, p.name AS place_name, p.latitude, p.longitude,
                 d.fcm_token, d.locale, s.last_class,
                 to_char(s.last_notified_on, 'YYYY-MM-DD') AS last_notified_on
            FROM tracked_places p
            JOIN place_devices d ON d.install_id = p.install_id
            LEFT JOIN place_risk_state s ON s.place_id = p.id
           WHERE p.notify_risk
             AND (s.last_checked_on IS NULL OR s.last_checked_on < $1::date)
           ORDER BY s.last_checked_on NULLS FIRST
           LIMIT 300`;
}

async function saveState(db: Db, placeId: string, cls: number | null, today: string, notified: boolean): Promise<void> {
  await db.query(
    `INSERT INTO place_risk_state (place_id, last_class, last_checked_on, last_notified_on)
     VALUES ($1, $2, $3::date, CASE WHEN $4 THEN $3::date END)
     ON CONFLICT (place_id) DO UPDATE SET
       last_class = EXCLUDED.last_class,
       last_checked_on = EXCLUDED.last_checked_on,
       last_notified_on = COALESCE(EXCLUDED.last_notified_on, place_risk_state.last_notified_on),
       updated_at = NOW()`,
    [placeId, cls, today, notified]
  );
}

interface Candidate {
  row: RiskRow;
  cls: number;
}

export async function runPlaceRiskAlerts(
  db: Db,
  send: Sender,
  sample: Sampler,
  now: Date = new Date(),
  opts: { forgetFcmTokens?: boolean } = {}
): Promise<PlaceRiskStats> {
  const stats: PlaceRiskStats = { skipped: false, checked: 0, pushesSent: 0, failed: 0, sampleErrors: 0 };
  const { date, hour } = turkeyClock(now);
  if (hour < RISK_CHECK_FIRST_HOUR || hour > RISK_CHECK_LAST_HOUR) return { ...stats, skipped: true };

  const { rows } = await db.query(dueRiskPlacesSql(), [date]);

  // Places are stored rounded to 2 decimals, so neighbours share one sample.
  const samples = new Map<string, number | null | 'error'>();
  const candidates = new Map<string, Candidate[]>();
  for (const row of rows as RiskRow[]) {
    const key = `${row.latitude},${row.longitude}`;
    if (!samples.has(key)) {
      if (samples.size >= RISK_CHECK_MAX_POINTS) continue;
      try {
        samples.set(key, await sample(Number(row.latitude), Number(row.longitude), date));
      } catch {
        samples.set(key, 'error');
        stats.sampleErrors++;
      }
    }
    const cls = samples.get(key)!;
    // A failed sample is retried next tick: no state is written.
    if (cls === 'error') continue;
    stats.checked++;
    if (shouldAlert(row.last_class, cls, row.last_notified_on, date) && row.fcm_token) {
      const list = candidates.get(row.install_id) ?? [];
      list.push({ row, cls: cls as number });
      candidates.set(row.install_id, list);
    } else {
      await saveState(db, row.place_id, cls, date, false);
    }
  }

  const devices = [...candidates.values()].map((list) => [...list].sort((a, b) => b.cls - a.cls));
  if (devices.length === 0) return stats;

  const messages: PushMessage[] = devices.map((list) => {
    const worst = list[0];
    const locale: Locale = worst.row.locale === 'en' ? 'en' : 'tr';
    const text = buildRiskAlertText(locale, worst.row.place_name, worst.cls, list.length - 1);
    return {
      token: worst.row.fcm_token!,
      title: text.title,
      body: text.body,
      data: { type: 'place_heat_summary', count: String(list.length), push_id: crypto.randomUUID() },
      androidChannelId: PLACES_ANDROID_CHANNEL,
      tag: `place-risk-${date}`,
      ttlSeconds: HEAT_ALERT_TTL_SECONDS,
    };
  });

  const results = await send(messages);
  const deadTokens: string[] = [];
  for (let i = 0; i < devices.length; i++) {
    const result = results[i];
    if (result?.success) {
      stats.pushesSent++;
      for (const { row, cls } of devices[i]) await saveState(db, row.place_id, cls, date, true);
    } else {
      stats.failed++;
      if (result?.deadToken) deadTokens.push(devices[i][0].row.fcm_token!);
      // Not recorded as checked, so a transient failure is retried next tick.
    }
  }
  if (deadTokens.length > 0) {
    await db.query(
      `UPDATE place_devices SET fcm_token = NULL, token_invalid_at = NOW() WHERE fcm_token = ANY($1::text[])`,
      [deadTokens]
    );
    if (opts.forgetFcmTokens !== false) await forgetDeadTokens(deadTokens);
  }
  return stats;
}

class PlaceRiskJob {
  async run(): Promise<PlaceRiskStats> {
    const startedAt = new Date();
    const empty: PlaceRiskStats = { skipped: true, checked: 0, pushesSent: 0, failed: 0, sampleErrors: 0 };
    if (!(await trackedPlacesAvailable(pool))) return empty;
    try {
      const stats = await runPlaceRiskAlerts(pool, (m) => notificationService.sendMessages(m), sampleFwiClass);
      if (!stats.skipped && (stats.checked > 0 || stats.sampleErrors > 0)) {
        await recordJobRun('place_risk', startedAt, 'ok', { ...stats });
      }
      return stats;
    } catch (error) {
      console.error('Place risk alerts failed:', (error as Error).message);
      await recordJobRun('place_risk', startedAt, 'failed', {}, error);
      return empty;
    }
  }
}

export default new PlaceRiskJob();
