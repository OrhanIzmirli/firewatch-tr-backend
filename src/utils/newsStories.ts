import { provinceInTitle } from './newsGeography';
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

const MAX_GAP_MS = 3 * 86_400_000;

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

/** A forest fire and a stubble fire in one province are two events. */
export function fireKind(title: string): 'forest' | 'field' | null {
  const t = turkishToLower(title);
  if (/orman/.test(t)) return 'forest';
  if (/otluk|anız|tarla|ot yangın|çöp/.test(t)) return 'field';
  return null;
}

/**
 * Groups headlines about one fire: same province, no gap over three days,
 * and no two different districts named. It would rather miss a link than
 * tell two fires' stories as one.
 */
export function buildStories(news: StoryInput[]): Story[] {
  const open: { province: string; last: number; places: Set<string>; kind: 'forest' | 'field' | null; items: StoryInput[] }[] = [];
  for (const n of [...news].sort((a, b) => a.published_at.getTime() - b.published_at.getTime())) {
    const province = provinceInTitle(n.title);
    if (!province) continue;
    const at = n.published_at.getTime();
    const places = placesIn(n.title, province);
    const kind = fireKind(n.title);
    const group = open.find(
      (g) => g.province === province && at - g.last <= MAX_GAP_MS && !disagree(g.places, places) && (!g.kind || !kind || g.kind === kind)
    );
    if (group) {
      group.items.push(n);
      group.last = at;
      places.forEach((p) => group.places.add(p));
      group.kind = group.kind ?? kind;
    } else {
      open.push({ province, last: at, places, kind, items: [n] });
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
