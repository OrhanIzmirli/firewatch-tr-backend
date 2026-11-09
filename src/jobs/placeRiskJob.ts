import { deviceNotMutedSql } from '../utils/alertConsent';
import crypto from 'crypto';
import pool from '../config/database';
import { recordJobRun } from '../services/jobRunRecorder';
import notificationService, { forgetDeadTokens, PushMessage, PushResult } from '../services/notificationService';
import { computePointRisk, defaultPointRiskDeps, roundToPointGrid } from '../services/pointRisk';
import { weatherSource } from '../services/weatherSource';
import { RISK_HIGH_INDEX, riskLevelIndex } from '../services/riskScore';
import {
  HEAT_ALERT_TTL_SECONDS,
  Locale,
  PLACES_ANDROID_CHANNEL,
  buildRiskAlertText,
  trackedPlacesAvailable,
} from '../services/trackedPlaces';

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

export const RISK_CHECK_FIRST_HOUR = 7;
export const RISK_CHECK_LAST_HOUR = 20;
/** The score follows the weather, so one morning check would miss the afternoon. */
export const RISK_CHECK_INTERVAL_HOURS = 3;
/** Upper bound per tick, to stay polite to the weather services. */
export const RISK_CHECK_MAX_POINTS = 60;

export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export type Sender = (messages: PushMessage[]) => Promise<PushResult[]>;
/** The level index (0 Low ... 3 Critical) and score at a point. */
export interface PlaceRiskReading {
  level: number;
  score: number;
}
export type Sampler = (lat: number, lng: number) => Promise<PlaceRiskReading>;

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
export function shouldAlert(previous: number | null, current: number, lastNotifiedOn: string | null, today: string): boolean {
  if (current < RISK_HIGH_INDEX) return false;
  if (lastNotifiedOn === today) return false;
  return previous === null || previous < RISK_HIGH_INDEX || current > previous;
}

export function dueRiskPlacesSql(): string {
  return `SELECT p.id AS place_id, p.install_id, p.name AS place_name, p.latitude, p.longitude,
                 d.fcm_token, d.locale, s.last_class,
                 to_char(s.last_notified_on, 'YYYY-MM-DD') AS last_notified_on
            FROM tracked_places p
            JOIN place_devices d ON d.install_id = p.install_id
            LEFT JOIN place_risk_state s ON s.place_id = p.id
           WHERE p.notify_risk
             AND ${deviceNotMutedSql('d')}
             AND (s.last_checked_at IS NULL
                  OR s.last_checked_at <= $1::timestamptz - make_interval(hours => $2))
           ORDER BY s.last_checked_at NULLS FIRST
           LIMIT 300`;
}

async function saveState(db: Db, placeId: string, cls: number, today: string, notified: boolean, at: Date): Promise<void> {
  await db.query(
    `INSERT INTO place_risk_state (place_id, last_class, last_checked_on, last_notified_on, last_checked_at)
     VALUES ($1, $2, $3::date, CASE WHEN $4 THEN $3::date END, $5::timestamptz)
     ON CONFLICT (place_id) DO UPDATE SET
       last_class = EXCLUDED.last_class,
       last_checked_on = EXCLUDED.last_checked_on,
       last_checked_at = EXCLUDED.last_checked_at,
       last_notified_on = COALESCE(EXCLUDED.last_notified_on, place_risk_state.last_notified_on),
       updated_at = NOW()`,
    [placeId, cls, today, notified, at]
  );
}

interface Candidate {
  row: RiskRow;
  reading: PlaceRiskReading;
}

export async function runPlaceRiskAlerts(
  db: Db,
  send: Sender,
  sample: Sampler,
  now: Date = new Date(),
  opts: { forgetFcmTokens?: boolean; prepare?: (points: { lat: number; lng: number }[]) => Promise<unknown> } = {}
): Promise<PlaceRiskStats> {
  const stats: PlaceRiskStats = { skipped: false, checked: 0, pushesSent: 0, failed: 0, sampleErrors: 0 };
  const { date, hour } = turkeyClock(now);
  if (hour < RISK_CHECK_FIRST_HOUR || hour > RISK_CHECK_LAST_HOUR) return { ...stats, skipped: true };

  const { rows } = await db.query(dueRiskPlacesSql(), [now, RISK_CHECK_INTERVAL_HOURS]);

  // One weather request for every due point, so the loop below reads the cache.
  if (opts.prepare) {
    const unique = new Map<string, { lat: number; lng: number }>();
    for (const row of rows as RiskRow[]) {
      const lat = roundToPointGrid(Number(row.latitude));
      const lng = roundToPointGrid(Number(row.longitude));
      if (unique.size < RISK_CHECK_MAX_POINTS) unique.set(`${lat},${lng}`, { lat, lng });
    }
    await opts.prepare([...unique.values()]).catch(() => undefined);
  }

  // The score is computed on a coarse grid, so neighbours share one reading.
  const samples = new Map<string, PlaceRiskReading | 'error'>();
  const candidates = new Map<string, Candidate[]>();
  for (const row of rows as RiskRow[]) {
    const key = `${roundToPointGrid(Number(row.latitude))},${roundToPointGrid(Number(row.longitude))}`;
    if (!samples.has(key)) {
      if (samples.size >= RISK_CHECK_MAX_POINTS) continue;
      try {
        samples.set(key, await sample(Number(row.latitude), Number(row.longitude)));
      } catch {
        samples.set(key, 'error');
        stats.sampleErrors++;
      }
    }
    const reading = samples.get(key)!;
    // A failed reading is retried next tick: no state is written.
    if (reading === 'error') continue;
    stats.checked++;
    if (shouldAlert(row.last_class, reading.level, row.last_notified_on, date) && row.fcm_token) {
      const list = candidates.get(row.install_id) ?? [];
      list.push({ row, reading });
      candidates.set(row.install_id, list);
    } else {
      await saveState(db, row.place_id, reading.level, date, false, now);
    }
  }

  const devices = [...candidates.values()].map((list) => [...list].sort((a, b) => b.reading.score - a.reading.score));
  if (devices.length === 0) return stats;

  const messages: PushMessage[] = devices.map((list) => {
    const worst = list[0];
    const locale: Locale = worst.row.locale === 'en' ? 'en' : 'tr';
    const text = buildRiskAlertText(locale, worst.row.place_name, worst.reading.level, worst.reading.score, list.length - 1);
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
      for (const { row, reading } of devices[i]) await saveState(db, row.place_id, reading.level, date, true, now);
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
      const deps = defaultPointRiskDeps(pool, 'places');
      const stats = await runPlaceRiskAlerts(pool, (m) => notificationService.sendMessages(m), async (lat, lng) => {
        const risk = await computePointRisk(lat, lng, deps);
        return { level: riskLevelIndex(risk.risk_level), score: risk.general_risk_score };
      }, new Date(), { prepare: (points) => weatherSource.readMany(points, 'places') });
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
