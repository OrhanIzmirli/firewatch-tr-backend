"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANNOUNCEMENT_LAST_HOUR = exports.ANNOUNCEMENT_FIRST_HOUR = exports.UPDATE_ANNOUNCEMENT = void 0;
exports.buildOf = buildOf;
exports.isOlderInstall = isOlderInstall;
exports.turkeyHour = turkeyHour;
exports.runUpdateAnnouncement = runUpdateAnnouncement;
/**
 * A one-time, calm note to installs that have not updated yet. It is run by
 * hand (scripts/announce-update.ts) and counts by default; sending needs an
 * explicit flag and the audience size repeated back.
 *
 * Old apps do not report a version, so "older" means no readable build or a
 * build below the target. The new app sends "FireWatch TR/1.2.0+8".
 */
exports.UPDATE_ANNOUNCEMENT = {
    title: "FireWatch TR'nin yeni sürümü hazır",
    body: "Öğrenme yolu ve ilerleme kaydı geldi. Uygun olduğunuzda Google Play'den güncelleyebilirsiniz.",
};
exports.ANNOUNCEMENT_FIRST_HOUR = 10;
exports.ANNOUNCEMENT_LAST_HOUR = 19;
const TEN_YEARS_SECONDS = 10 * 365 * 24 * 60 * 60;
const THREE_DAYS_SECONDS = 3 * 24 * 60 * 60;
function buildOf(deviceName) {
    const m = /^FireWatch TR\/[\d.]+\+(\d+)$/.exec(deviceName ?? '');
    return m ? Number(m[1]) : null;
}
function isOlderInstall(deviceName, targetBuild) {
    const build = buildOf(deviceName);
    return build === null || build < targetBuild;
}
function turkeyHour(now) {
    return (now.getUTCHours() + 3) % 24;
}
async function runUpdateAnnouncement(deps, options) {
    const key = `announcement:sent:${options.campaign}`;
    const rows = await deps.installs();
    const tokens = [...new Set(rows.filter((r) => isOlderInstall(r.device_name, options.targetBuild)).map((r) => r.token))];
    const audience = tokens.length;
    const sentBefore = await deps.alreadySent(key);
    if (!options.send)
        return { mode: 'dry-run', audience, alreadySent: sentBefore };
    const refuse = (reason) => ({ mode: 'refused', audience, reason });
    if (sentBefore)
        return refuse('already sent for this campaign');
    if (options.confirmCount !== audience)
        return refuse(`confirm count must equal the audience (${audience})`);
    const hour = turkeyHour(deps.now());
    if (hour < exports.ANNOUNCEMENT_FIRST_HOUR || hour > exports.ANNOUNCEMENT_LAST_HOUR)
        return refuse('only sent between 10:00 and 19:59 Turkey time');
    // Marked first: a crash half way must not lead to a second send.
    if (!(await deps.markSent(key, TEN_YEARS_SECONDS)))
        return refuse('could not record the one-time guard (is Redis configured?)');
    const results = await deps.send(tokens.map((token) => ({
        token,
        ...exports.UPDATE_ANNOUNCEMENT,
        data: { type: 'app_update' },
        priority: 'normal',
        ttlSeconds: THREE_DAYS_SECONDS,
    })));
    const delivered = results.filter((r) => r.success).length;
    const dead = tokens.filter((_, i) => results[i]?.deadToken);
    if (dead.length > 0)
        await deps.forget(dead);
    const outcome = { mode: 'sent', audience, delivered, failed: audience - delivered };
    await deps.record({ campaign: options.campaign, audience, delivered, failed: outcome.failed, target_build: options.targetBuild });
    return outcome;
}
