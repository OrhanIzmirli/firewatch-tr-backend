/**
 * The minimum-version setting and the one-time update announcement.
 *
 *   npm run test:app-update
 */
import assert from 'node:assert';
import { minSupportedVersion, NO_MINIMUM_VERSION } from '../src/routes/appConfig';
import {
  AnnouncementDeps,
  UPDATE_ANNOUNCEMENT,
  buildOf,
  isOlderInstall,
  runUpdateAnnouncement,
} from '../src/services/updateAnnouncement';

let failures = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

const midday = new Date('2026-11-20T09:00:00Z');
const installs = [
  { token: 'old-a', device_name: 'FireWatch TR App' },
  { token: 'old-b', device_name: null },
  { token: 'old-c', device_name: 'FireWatch TR/1.1.0+7' },
  { token: 'new-a', device_name: 'FireWatch TR/1.2.0+8' },
  { token: 'new-b', device_name: 'FireWatch TR/1.3.0+9' },
];
function deps(over: Partial<AnnouncementDeps> = {}) {
  const state = { sent: [] as string[], marked: [] as string[], forgot: [] as string[], recorded: 0, order: [] as string[] };
  const d: AnnouncementDeps = {
    installs: async () => installs,
    send: async (m) => { state.order.push('send'); state.sent.push(...m.map((x) => x.token)); return m.map((x) => ({ success: x.token !== 'old-b', deadToken: x.token === 'old-b' })); },
    forget: async (x) => { state.forgot.push(...x); },
    alreadySent: async (k) => state.marked.includes(k),
    markSent: async (k) => { state.order.push('mark'); state.marked.push(k); return true; },
    record: async () => { state.recorded++; },
    now: () => midday,
    ...over,
  };
  return { d, state };
}
const options = { send: true, confirmCount: 3, targetBuild: 8, campaign: 'c1' };

(async () => {
  await t('the default forces nobody', () => {
    assert.strictEqual(minSupportedVersion(undefined), NO_MINIMUM_VERSION);
    assert.strictEqual(NO_MINIMUM_VERSION, '0.0.0');
  });
  await t('a bad setting forces nobody; a good one is kept', () => {
    assert.strictEqual(minSupportedVersion('latest'), NO_MINIMUM_VERSION);
    assert.strictEqual(minSupportedVersion(''), NO_MINIMUM_VERSION);
    assert.strictEqual(minSupportedVersion(' 1.2.0 '), '1.2.0');
  });
  await t('the build is read from the new client string only', () => {
    assert.strictEqual(buildOf('FireWatch TR/1.2.0+8'), 8);
    assert.strictEqual(buildOf('FireWatch TR App'), null);
    assert.ok(isOlderInstall(null, 8));
    assert.ok(isOlderInstall('FireWatch TR/1.1.0+7', 8));
    assert.ok(!isOlderInstall('FireWatch TR/1.2.0+8', 8));
  });
  await t('the text does not read like a fire warning', () => {
    const text = `${UPDATE_ANNOUNCEMENT.title} ${UPDATE_ANNOUNCEMENT.body}`.toLocaleLowerCase('tr');
    for (const word of ['yangın', 'uyarı', 'acil', 'risk', 'tehlike', 'dikkat', 'hemen', '112', '!']) {
      assert.ok(!text.includes(word), word);
    }
  });
  await t('counting is the default and sends nothing', async () => {
    const { d, state } = deps();
    const r = await runUpdateAnnouncement(d, { ...options, send: false, confirmCount: undefined });
    assert.deepStrictEqual(r, { mode: 'dry-run', audience: 3, alreadySent: false });
    assert.strictEqual(state.sent.length, 0);
    assert.strictEqual(state.marked.length, 0);
  });
  await t('sending needs the audience size repeated back', async () => {
    const { d, state } = deps();
    for (const confirmCount of [undefined, 2]) {
      const r = await runUpdateAnnouncement(d, { ...options, confirmCount });
      assert.strictEqual(r.mode, 'refused');
    }
    assert.strictEqual(state.sent.length, 0);
  });
  await t('only older installs get it, at normal priority, after the guard is set', async () => {
    const seen: string[] = [];
    const { d, state } = deps();
    const send = d.send;
    d.send = async (m) => { m.forEach((x) => { assert.strictEqual(x.priority, 'normal'); assert.strictEqual(x.data.type, 'app_update'); seen.push(x.token); }); return send(m); };
    const r = await runUpdateAnnouncement(d, options);
    assert.deepStrictEqual(r, { mode: 'sent', audience: 3, delivered: 2, failed: 1 });
    assert.deepStrictEqual(seen, ['old-a', 'old-b', 'old-c']);
    assert.deepStrictEqual(state.order, ['mark', 'send']);
    assert.deepStrictEqual(state.forgot, ['old-b']);
    assert.strictEqual(state.recorded, 1);
  });
  await t('a campaign goes out once', async () => {
    const { d, state } = deps();
    await runUpdateAnnouncement(d, options);
    const again = await runUpdateAnnouncement(d, options);
    assert.strictEqual(again.mode, 'refused');
    assert.strictEqual(state.sent.length, 3);
  });
  await t('nothing is sent at night', async () => {
    const { d, state } = deps({ now: () => new Date('2026-11-20T21:00:00Z') });
    assert.strictEqual((await runUpdateAnnouncement(d, options)).mode, 'refused');
    assert.strictEqual(state.sent.length, 0);
  });
  await t('nothing is sent when the guard cannot be saved', async () => {
    const { d, state } = deps({ markSent: async () => false });
    assert.strictEqual((await runUpdateAnnouncement(d, options)).mode, 'refused');
    assert.strictEqual(state.sent.length, 0);
  });

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
