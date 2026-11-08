import { headlineProvince } from './publicNews';
import type { DistrictRef } from '../services/placeMention';
import { newsKind } from './newsKinds';
import { turkishToLower } from './turkishText';

export type StoryStage = 'started' | 'controlled' | 'out' | 'restoration';

export interface StoryInput {
  id: number;
  title: string;
  source: string | null;
  source_url: string | null;
  published_at: Date;
}

export interface Story {
  id: string;
  province: string;
  count: number;
  stages: StoryStage[];
  items: (StoryInput & { stage: StoryStage | null })[];
}

const DAY_MS = 86_400_000;
/** One fire: at most this long between two headlines, and this long overall. */
const MAX_GAP_MS = 2 * DAY_MS;
const MAX_SPAN_MS = 8 * DAY_MS;
/** A headline that does not say what burned joins only when this close. */
const UNKNOWN_KIND_GAP_MS = DAY_MS;

/** What a headline says happened. Null when it says none of these. */
export function stageOf(title: string): StoryStage | null {
  const t = turkishToLower(title);
  if (/ağaçlandır|fidan dikim|fidan dik|restorasyon|yeniden yeşer/.test(t)) return 'restoration';
  if (/söndürüldü/.test(t)) return 'out';
  if (/kontrol altına alındı|kontrol altında/.test(t)) return 'controlled';
  if (/çıktı|çıkan|başladı|müdahale/.test(t)) return 'started';
  return null;
}

/** Place names a headline attaches a case ending to: "Kumluca'da". The province itself does not count. */
export function placesIn(title: string, province: string): Set<string> {
  const out = new Set<string>();
  for (const m of title.matchAll(/([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)['’]/g)) {
    const place = turkishToLower(m[1]);
    if (place !== turkishToLower(province)) out.add(place);
  }
  return out;
}

const disagree = (a: Set<string>, b: Set<string>) => a.size > 0 && b.size > 0 && ![...a].some((p) => b.has(p));

/**
 * Groups headlines about one fire: same province, no gap over three days,
 * and no two different districts named. It would rather miss a link than
 * tell two fires' stories as one.
 */
export function buildStories(news: StoryInput[], districts: readonly DistrictRef[] = []): Story[] {
  const open: { province: string; first: number; last: number; places: Set<string>; kind: 'fire' | 'field' | null; items: StoryInput[] }[] = [];
  for (const n of [...news].sort((a, b) => a.published_at.getTime() - b.published_at.getTime())) {
    const province = headlineProvince(n.title, districts);
    if (!province) continue;
    const rawKind = newsKind(n.title);
    if (rawKind !== null && rawKind !== 'fire' && rawKind !== 'field') continue;
    // A headline saying only "fire" does not say what burned.
    const kind = rawKind === 'fire' && !turkishToLower(n.title).includes('orman') ? null : rawKind;
    const at = n.published_at.getTime();
    const places = placesIn(n.title, province);
    const group = open.find(
      (g) =>
        g.province === province &&
        at - g.last <= (kind && g.kind ? MAX_GAP_MS : UNKNOWN_KIND_GAP_MS) &&
        at - g.first <= MAX_SPAN_MS &&
        !disagree(g.places, places) &&
        (!g.kind || !kind || g.kind === kind)
    );
    if (group) {
      group.items.push(n);
      group.last = at;
      places.forEach((p) => group.places.add(p));
      group.kind = group.kind ?? kind;
    } else {
      open.push({ province, first: at, last: at, places, kind, items: [n] });
    }
  }
  const order: StoryStage[] = ['started', 'controlled', 'out', 'restoration'];
  return open
    .filter((g) => g.items.length >= 2)
    .map((g) => {
      const items = g.items.map((i) => ({ ...i, stage: stageOf(i.title) }));
      return {
        id: `${g.province}-${g.items[0].id}`,
        province: g.province,
        count: items.length,
        stages: order.filter((s) => items.some((i) => i.stage === s)),
        items,
      };
    })
    .sort((a, b) => b.items[b.count - 1].published_at.getTime() - a.items[a.count - 1].published_at.getTime());
}
