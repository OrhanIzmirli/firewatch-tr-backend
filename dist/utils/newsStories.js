"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stageOf = stageOf;
exports.placesIn = placesIn;
exports.buildStories = buildStories;
const publicNews_1 = require("./publicNews");
const newsKinds_1 = require("./newsKinds");
const turkishText_1 = require("./turkishText");
const DAY_MS = 86400000;
/** One fire: at most this long between two headlines, and this long overall. */
const MAX_GAP_MS = 2 * DAY_MS;
const MAX_SPAN_MS = 8 * DAY_MS;
/** A headline that does not say what burned joins only when this close. */
const UNKNOWN_KIND_GAP_MS = DAY_MS;
/** What a headline says happened. Null when it says none of these. */
function stageOf(title) {
    const t = (0, turkishText_1.turkishToLower)(title);
    if (/ağaçlandır|fidan dikim|fidan dik|restorasyon|yeniden yeşer/.test(t))
        return 'restoration';
    if (/söndürüldü/.test(t))
        return 'out';
    if (/kontrol altına alındı|kontrol altında/.test(t))
        return 'controlled';
    if (/çıktı|çıkan|başladı|müdahale/.test(t))
        return 'started';
    return null;
}
/** Place names a headline attaches a case ending to: "Kumluca'da". The province itself does not count. */
function placesIn(title, province) {
    const out = new Set();
    for (const m of title.matchAll(/([A-ZÇĞİÖŞÜ][a-zçğıöşü]+)['’]/g)) {
        const place = (0, turkishText_1.turkishToLower)(m[1]);
        if (place !== (0, turkishText_1.turkishToLower)(province))
            out.add(place);
    }
    return out;
}
const disagree = (a, b) => a.size > 0 && b.size > 0 && ![...a].some((p) => b.has(p));
/**
 * Groups headlines about one fire: same province, no gap over three days,
 * and no two different districts named. It would rather miss a link than
 * tell two fires' stories as one.
 */
function buildStories(news, districts = []) {
    const open = [];
    for (const n of [...news].sort((a, b) => a.published_at.getTime() - b.published_at.getTime())) {
        const province = (0, publicNews_1.headlineProvince)(n.title, districts);
        if (!province)
            continue;
        const rawKind = (0, newsKinds_1.newsKind)(n.title);
        if (rawKind !== null && rawKind !== 'fire' && rawKind !== 'field')
            continue;
        // A headline saying only "fire" does not say what burned.
        const kind = rawKind === 'fire' && !(0, turkishText_1.turkishToLower)(n.title).includes('orman') ? null : rawKind;
        const at = n.published_at.getTime();
        const places = placesIn(n.title, province);
        const group = open.find((g) => g.province === province &&
            at - g.last <= (kind && g.kind ? MAX_GAP_MS : UNKNOWN_KIND_GAP_MS) &&
            at - g.first <= MAX_SPAN_MS &&
            !disagree(g.places, places) &&
            (!g.kind || !kind || g.kind === kind));
        if (group) {
            group.items.push(n);
            group.last = at;
            places.forEach((p) => group.places.add(p));
            group.kind = group.kind ?? kind;
        }
        else {
            open.push({ province, first: at, last: at, places, kind, items: [n] });
        }
    }
    const order = ['started', 'controlled', 'out', 'restoration'];
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
