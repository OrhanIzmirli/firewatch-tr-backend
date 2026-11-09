/**
 * A one-time, calm note to installs that have not updated yet. It is run by
 * hand (scripts/announce-update.ts) and counts by default; sending needs an
 * explicit flag and the audience size repeated back.
 *
 * Old apps do not report a version, so "older" means no readable build or a
 * build below the target. The new app sends "FireWatch TR/1.2.0+8".
 */
export const UPDATE_ANNOUNCEMENT = {
  title: "FireWatch TR'nin yeni sürümü hazır",
  body: "Öğrenme yolu ve ilerleme kaydı geldi. Uygun olduğunuzda Google Play'den güncelleyebilirsiniz.",
} as const;

export const ANNOUNCEMENT_FIRST_HOUR = 10;
export const ANNOUNCEMENT_LAST_HOUR = 19;
const TEN_YEARS_SECONDS = 10 * 365 * 24 * 60 * 60;
const THREE_DAYS_SECONDS = 3 * 24 * 60 * 60;

export function buildOf(deviceName: string | null | undefined): number | null {
  const m = /^FireWatch TR\/[\d.]+\+(\d+)$/.exec(deviceName ?? '');
  return m ? Number(m[1]) : null;
}

export function isOlderInstall(deviceName: string | null | undefined, targetBuild: number): boolean {
  const build = buildOf(deviceName);
  return build === null || build < targetBuild;
}

export function turkeyHour(now: Date): number {
  return (now.getUTCHours() + 3) % 24;
}

export interface AnnouncementMessage {
  token: string;
  title: string;
  body: string;
  data: Record<string, string>;
  priority: 'normal';
  ttlSeconds: number;
}

export interface AnnouncementDeps {
  installs: () => Promise<{ token: string; device_name: string | null }[]>;
  send: (messages: AnnouncementMessage[]) => Promise<{ success: boolean; deadToken: boolean }[]>;
  forget: (tokens: string[]) => Promise<void>;
  alreadySent: (key: string) => Promise<boolean>;
  markSent: (key: string, ttlSeconds: number) => Promise<boolean>;
  record: (stats: Record<string, unknown>) => Promise<void>;
  now: () => Date;
}

export interface AnnouncementOptions {
  send: boolean;
  confirmCount?: number;
  targetBuild: number;
  campaign: string;
}

export type AnnouncementOutcome =
  | { mode: 'dry-run'; audience: number; alreadySent: boolean }
  | { mode: 'refused'; audience: number; reason: string }
  | { mode: 'sent'; audience: number; delivered: number; failed: number };

export async function runUpdateAnnouncement(
  deps: AnnouncementDeps,
  options: AnnouncementOptions
): Promise<AnnouncementOutcome> {
  const key = `announcement:sent:${options.campaign}`;
  const rows = await deps.installs();
  const tokens = [...new Set(rows.filter((r) => isOlderInstall(r.device_name, options.targetBuild)).map((r) => r.token))];
  const audience = tokens.length;
  const sentBefore = await deps.alreadySent(key);
  if (!options.send) return { mode: 'dry-run', audience, alreadySent: sentBefore };

  const refuse = (reason: string): AnnouncementOutcome => ({ mode: 'refused', audience, reason });
  if (sentBefore) return refuse('already sent for this campaign');
  if (options.confirmCount !== audience) return refuse(`confirm count must equal the audience (${audience})`);
  const hour = turkeyHour(deps.now());
  if (hour < ANNOUNCEMENT_FIRST_HOUR || hour > ANNOUNCEMENT_LAST_HOUR) return refuse('only sent between 10:00 and 19:59 Turkey time');
  // Marked first: a crash half way must not lead to a second send.
  if (!(await deps.markSent(key, TEN_YEARS_SECONDS))) return refuse('could not record the one-time guard (is Redis configured?)');

  const results = await deps.send(
    tokens.map((token) => ({
      token,
      ...UPDATE_ANNOUNCEMENT,
      data: { type: 'app_update' },
      priority: 'normal' as const,
      ttlSeconds: THREE_DAYS_SECONDS,
    }))
  );
  const delivered = results.filter((r) => r.success).length;
  const dead = tokens.filter((_, i) => results[i]?.deadToken);
  if (dead.length > 0) await deps.forget(dead);
  const outcome = { mode: 'sent' as const, audience, delivered, failed: audience - delivered };
  await deps.record({ campaign: options.campaign, audience, delivered, failed: outcome.failed, target_build: options.targetBuild });
  return outcome;
}
