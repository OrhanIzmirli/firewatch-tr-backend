import { deviceNotMutedSql } from '../utils/alertConsent';
import crypto from 'crypto';
import pool from '../config/database';
import { recordJobRun } from '../services/jobRunRecorder';
import { heatSourceSqlCondition } from '../services/heatSource';
import { naturalOrConfirmedSql } from '../services/landCover';
import notificationService, { forgetDeadTokens, PushMessage, PushResult } from '../services/notificationService';
import {
  HEAT_ALERT_CAP_WINDOW_HOURS,
  HEAT_ALERT_DEVICE_CAP,
  HEAT_ALERT_MAX_AGE_HOURS,
  HEAT_ALERT_MIN_TIERS,
  HEAT_ALERT_TTL_SECONDS,
  Locale,
  PLACES_ANDROID_CHANNEL,
  buildHeatAlertText,
  buildHeatSummaryText,
  trackedPlacesAvailable,
} from '../services/trackedPlaces';

/**
 * Tracked-place heat alerts (app 1.2.0). Runs right after clustering, in the
 * same ingest tick (jobs/fireIngestJob.ts).
 *
 * 1. Summaries first: a device with held detections whose cap window has
 *    ended (fewer than HEAT_ALERT_DEVICE_CAP pushes in the last
 *    HEAT_ALERT_CAP_WINDOW_HOURS) gets one push — "N new detections near
 *    your places" — and those rows become 'summarized'. Nothing over the cap
 *    is ever dropped.
 * 2. New pairs: every (place, incident) where the incident centroid is in
 *    the place's radius, was seen in the last 12 h, has reached nominal or
 *    high confidence and is not a persistent heat source, is recorded once
 *    (primary key). Per device they become one push naming the nearest pair
 *    ("+N more") — or, at the cap, 'held' for step 1 of a later run.
 *
 * The cap counts pushes (distinct push_id), summaries included.
 */

/** Anything with pg's query(); the pool in production, a test client in tests. */
export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}
export type Sender = (messages: PushMessage[]) => Promise<PushResult[]>;

export interface PlaceAlertStats {
  skipped: boolean;
  newPairs: number;
  pushesSent: number;
  summariesSent: number;
  held: number;
  undeliverable: number;
  failed: number;
  deadTokens: number;
}

export interface NewPair {
  place_id: string;
  install_id: string;
  incident_id: string;
  place_name: string;
  distance_m: number;
  /** Incident centroid (satellite data, not the user's), for the map deep link. */
  incident_lat: number;
  incident_lng: number;
  fcm_token: string | null;
  locale: Locale;
  recent_pushes: number;
}

export interface HeldDevice {
  install_id: string;
  fcm_token: string | null;
  locale: Locale;
  held_detections: number;
}

const RECENT_PUSHES_SQL = (installIdExpr: string) => `
  (SELECT count(DISTINCT x.push_id)::int FROM place_notifications x
    WHERE x.install_id = ${installIdExpr} AND x.push_id IS NOT NULL
      AND x.pushed_at > NOW() - make_interval(hours => ${HEAT_ALERT_CAP_WINDOW_HOURS}))`;

/** Held detections must not arrive as a late summary after alerts come back on. */
export function dropHeldOfMutedSql(): string {
  return `
    UPDATE place_notifications n SET status = 'undeliverable'
    FROM place_devices d
    WHERE n.status = 'held' AND d.install_id = n.install_id AND NOT ${deviceNotMutedSql('d')}
  `;
}

/** Devices whose held detections are due a summary (cap window over). */
export function dueSummariesSql(): string {
  return `
    SELECT d.install_id, d.fcm_token, d.locale, count(DISTINCT n.ref_key)::int AS held_detections
    FROM place_notifications n
    JOIN place_devices d ON d.install_id = n.install_id
    WHERE n.status = 'held'
      AND ${RECENT_PUSHES_SQL('d.install_id')} < ${HEAT_ALERT_DEVICE_CAP}
    GROUP BY d.install_id, d.fcm_token, d.locale
  `;
}

/** Records and returns the new (place, incident) pairs of this run. */
export function newHeatPairsSql(): string {
  const tiers = HEAT_ALERT_MIN_TIERS.map((t) => `'${t}'`).join(', ');
  return `
    WITH candidates AS (
      SELECT p.id AS place_id, p.install_id, i.id AS incident_id
      FROM tracked_places p
      JOIN place_devices d ON d.install_id = p.install_id
      JOIN fire_incidents i
        ON ST_DWithin(p.geom, i.centroid::geography, p.radius_m)
      WHERE p.notify_heat
        AND ${deviceNotMutedSql('d')}
        AND i.last_detected_at > NOW() - make_interval(hours => ${HEAT_ALERT_MAX_AGE_HOURS})
        AND i.peak_confidence_tier IN (${tiers})
        AND NOT COALESCE((${heatSourceSqlCondition('i')}), false)
        AND ${naturalOrConfirmedSql('i')}
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

export interface DevicePush {
  installId: string;
  token: string;
  locale: Locale;
  nearest: NewPair;
  extra: number;
  pairs: NewPair[];
}

export interface PushPlan {
  pushes: DevicePush[];
  /** Pairs over the device's cap: kept for the summary. */
  held: NewPair[];
  /** Pairs of devices without a live token. */
  undeliverable: NewPair[];
}

/** Pure: new pairs → at most one push per device, honouring the cap. */
export function planDevicePushes(pairs: NewPair[]): PushPlan {
  const byDevice = new Map<string, NewPair[]>();
  for (const pair of pairs) {
    const list = byDevice.get(pair.install_id) ?? [];
    list.push(pair);
    byDevice.set(pair.install_id, list);
  }
  const plan: PushPlan = { pushes: [], held: [], undeliverable: [] };
  for (const [installId, list] of byDevice) {
    const first = list[0];
    if (!first.fcm_token) {
      plan.undeliverable.push(...list);
      continue;
    }
    if (first.recent_pushes >= HEAT_ALERT_DEVICE_CAP) {
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

export function buildPushMessage(push: DevicePush): PushMessage {
  const text = buildHeatAlertText(push.locale, push.nearest.place_name, Number(push.nearest.distance_m), push.extra);
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
    androidChannelId: PLACES_ANDROID_CHANNEL,
    // Same incident → same tag, so a resend can never stack two banners.
    tag: `incident-${push.nearest.incident_id}`,
    ttlSeconds: HEAT_ALERT_TTL_SECONDS,
  };
}

export function buildSummaryMessage(device: HeldDevice): PushMessage {
  const text = buildHeatSummaryText(device.locale === 'en' ? 'en' : 'tr', device.held_detections);
  return {
    token: device.fcm_token!,
    title: text.title,
    body: text.body,
    data: { type: 'place_heat_summary', count: String(device.held_detections) },
    androidChannelId: PLACES_ANDROID_CHANNEL,
    tag: 'places-summary',
    ttlSeconds: HEAT_ALERT_TTL_SECONDS,
  };
}

async function setStatus(db: Db, pairs: NewPair[], status: 'held' | 'undeliverable'): Promise<void> {
  if (pairs.length === 0) return;
  await db.query(
    `UPDATE place_notifications SET status = $1
     WHERE kind = 'heat' AND (place_id, ref_key) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))`,
    [status, pairs.map((p) => p.place_id), pairs.map((p) => String(p.incident_id))]
  );
}

async function markPushed(db: Db, pairs: NewPair[], pushId: string): Promise<void> {
  await db.query(
    `UPDATE place_notifications SET status = 'sent', push_id = $1, pushed_at = NOW()
     WHERE kind = 'heat' AND (place_id, ref_key) IN (SELECT * FROM unnest($2::uuid[], $3::text[]))`,
    [pushId, pairs.map((p) => p.place_id), pairs.map((p) => String(p.incident_id))]
  );
}

async function clearDeadTokens(db: Db, tokens: string[], alsoFcmTokens: boolean): Promise<void> {
  if (tokens.length === 0) return;
  await db.query(
    `UPDATE place_devices SET fcm_token = NULL, token_invalid_at = NOW() WHERE fcm_token = ANY($1::text[])`,
    [tokens]
  );
  // The same token may also be on fcm_tokens; it is just as dead there.
  if (alsoFcmTokens) await forgetDeadTokens(tokens);
}

/**
 * One full pass over [db] with [send]. Exported for the PostGIS test, which
 * runs it on a rolled-back transaction with a fake sender.
 */
export async function runPlaceAlerts(db: Db, send: Sender, opts: { forgetFcmTokens?: boolean } = {}): Promise<PlaceAlertStats> {
  const stats: PlaceAlertStats = {
    skipped: false, newPairs: 0, pushesSent: 0, summariesSent: 0, held: 0, undeliverable: 0, failed: 0, deadTokens: 0,
  };
  const forget = opts.forgetFcmTokens ?? true;

  await db.query(dropHeldOfMutedSql());

  // 1. Summaries for devices whose cap window has ended.
  const due = (await db.query(dueSummariesSql())).rows as HeldDevice[];
  const noToken = due.filter((d) => !d.fcm_token);
  if (noToken.length > 0) {
    await db.query(
      `UPDATE place_notifications SET status = 'undeliverable'
       WHERE status = 'held' AND install_id = ANY($1::uuid[])`,
      [noToken.map((d) => d.install_id)]
    );
    stats.undeliverable += noToken.length;
  }
  const summaries = due.filter((d) => d.fcm_token);
  if (summaries.length > 0) {
    const results = await send(summaries.map(buildSummaryMessage));
    const dead: string[] = [];
    for (const [i, r] of results.entries()) {
      const device = summaries[i];
      if (r.success) {
        await db.query(
          `UPDATE place_notifications SET status = 'summarized', push_id = $2, pushed_at = NOW()
           WHERE status = 'held' AND install_id = $1`,
          [device.install_id, crypto.randomUUID()]
        );
        stats.summariesSent++;
      } else if (r.deadToken) {
        dead.push(device.fcm_token!);
        await db.query(
          `UPDATE place_notifications SET status = 'undeliverable' WHERE status = 'held' AND install_id = $1`,
          [device.install_id]
        );
      } else {
        stats.failed++; // stays held; the next run tries again
      }
    }
    stats.deadTokens += dead.length;
    await clearDeadTokens(db, dead, forget);
  }

  // 2. New pairs.
  const pairs = (await db.query(newHeatPairsSql())).rows as NewPair[];
  stats.newPairs = pairs.length;
  if (pairs.length === 0) return stats;

  const plan = planDevicePushes(pairs);
  await setStatus(db, plan.held, 'held');
  await setStatus(db, plan.undeliverable, 'undeliverable');
  stats.held += plan.held.length;
  stats.undeliverable += plan.undeliverable.length;

  if (plan.pushes.length > 0) {
    const results = await send(plan.pushes.map(buildPushMessage));
    const dead: string[] = [];
    for (const [i, r] of results.entries()) {
      const push = plan.pushes[i];
      if (r.success) {
        await markPushed(db, push.pairs, crypto.randomUUID());
        stats.pushesSent++;
      } else if (r.deadToken) {
        dead.push(push.token);
        await setStatus(db, push.pairs, 'undeliverable');
      } else {
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
  async run(): Promise<PlaceAlertStats> {
    const startedAt = new Date();
    if (!(await trackedPlacesAvailable(pool))) {
      // Migration 014 not applied: nothing to do, nothing to record.
      return { skipped: true, newPairs: 0, pushesSent: 0, summariesSent: 0, held: 0, undeliverable: 0, failed: 0, deadTokens: 0 };
    }
    try {
      const stats = await runPlaceAlerts(pool, (m) => notificationService.sendMessages(m));
      if (stats.newPairs > 0 || stats.summariesSent > 0 || stats.failed > 0) {
        console.log(
          `📍 Place alerts: ${stats.newPairs} new pair(s), ${stats.pushesSent} push(es), ${stats.summariesSent} summary(ies), ` +
            `${stats.held} held, ${stats.undeliverable} undeliverable, ${stats.failed} failed, ${stats.deadTokens} dead token(s)`
        );
      }
      await recordJobRun('place_alerts', startedAt, 'ok', { ...stats });
      return stats;
    } catch (error) {
      console.error('Place alerts failed:', (error as Error).message);
      await recordJobRun('place_alerts', startedAt, 'failed', {}, error);
      return { skipped: false, newPairs: 0, pushesSent: 0, summariesSent: 0, held: 0, undeliverable: 0, failed: 0, deadTokens: 0 };
    }
  }
}

export default new PlaceAlertJob();
