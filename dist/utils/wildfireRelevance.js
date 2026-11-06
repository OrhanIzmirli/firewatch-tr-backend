"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessWildfire = assessWildfire;
const turkishText_1 = require("./turkishText");
/**
 * Is this news item about a wildfire (forest, scrub, grass, field fire)?
 *
 * The scraper's keyword whitelist admits anything with "yangın", "alev",
 * "fırtına", "tahliye"... — apartment and car fires, storms, floods and a
 * few plainly unrelated stories all landed in the app's fires feed. This is
 * the second gate: an item must name vegetation burning.
 *
 *   STRONG  forest/scrub/grazing-land wording, or the aerial-and-ground
 *           response phrase OGM uses for wildfires. One is enough,
 *           provided the item mentions fire at all (FIRE_WORD).
 *   WEAK    words that also appear around building and vehicle fires
 *           (a car fire "spread to the grass", a shack "in a field").
 *           They count only when the item mentions fire AND its title
 *           does not name a building, vehicle or facility.
 *
 * Keywords match only at the start of a word: bare "orman" is inside
 * "performans" and "mera" inside "kamera".
 *
 * Measured 2026-11-06 on the 1,493 stored news items: of the 629 that pass
 * the existing whitelist, 192 pass this gate. Every title naming a building
 * or vehicle among the 192 was still a wildfire story. Known misses are
 * headlines that name only a place ("Muğla Seydikemer'de çıkan yangın
 * Kaş'a sıçradı", "Ege'de peş peşe yangınlar") with no vegetation word in
 * title or summary.
 */
const STRONG = [
    'orman', // orman yangını, ormanlık alan, ormanlar, orman dışı alan, Orman Bölge Müdürlüğü...
    'makilik', 'maki alan', 'makiye',
    'fundalık',
    'meşelik',
    'kızılçam',
    'zeytinlik',
    'anız',
    'örtü yangın',
    'açık alan yangın',
    'zirai alan',
    'mera alan',
    'milli park',
    'havadan ve karadan',
    'söndürme uçağı',
    'yangın söndürme helikopter',
    'söndürme helikopter',
    'ogm',
    'wildfire',
    'forest fire',
];
const WEAK = [
    'otluk', 'otlak',
    'tarla',
    'tarım arazi', 'tarım alan',
    'hektar', 'dönüm',
    'yanan alan',
    'arazöz',
    'sazlık', 'kamışlık',
    'dağlık alan', 'ağaçlık alan', 'kırsal alan',
    'arazi yangın',
    'bahçelik',
    'yangın bölge',
];
/**
 * Every kept item must be about fire. "giriş yasağı" covers the
 * forest-entry bans issued against wildfires; without this check a crime
 * story set "in a wooded area" passed on "orman" alone (#3650).
 */
const FIRE_WORD = /yang[ıi]n|alev|söndür|fire|blaze|giriş yasa/;
/** Building, vehicle or facility named in a title: weak signals then don't count. */
const BUILDING_OR_VEHICLE_IN_TITLE = /(^|[\s'’"(])(ev|evi|evde|evler|evleri|evinde|fabrika\S*|apartman\S*|daire\S*|bina\S*|otomobil\S*|araç\S*|aracı|tır|tır\S*|otobüs\S*|minibüs\S*|kamyon\S*|tanker\S*|depo\S*|baraka\S*|ahır\S*|samanlık\S*|işyeri\S*|iş yeri\S*|market\S*|mağaza\S*|tesis\S*|atölye\S*|restoran\S*|otel\S*|okul\S*|hastane\S*|cami\S*|tekne\S*|gemi\S*|uçak|jet|trafo\S*|baz istasyon\S*|plaza\S*|gecekondu\S*|konteyner\S*|çatı\S*)(?=$|[\s,.!?:;'’"):])/;
/** Lowercase Turkish letters and digits: a keyword must not follow one. */
const WORD_CHAR = 'a-zçğıöşüâîû0-9';
const compile = (keywords) => keywords.map((kw) => ({ kw, re: new RegExp(`(^|[^${WORD_CHAR}])${kw}`) }));
const STRONG_RE = compile(STRONG);
const WEAK_RE = compile(WEAK);
/**
 * Phrases that contain a signal word but describe something else: an
 * "orman ürünleri fabrikası" is a timber/furniture plant (#1916, #3685).
 */
const NOT_A_SIGNAL = /orman ürün\S*/g;
function assessWildfire(title, fullText) {
    const titleLower = (0, turkishText_1.turkishToLower)(title);
    const text = (0, turkishText_1.turkishToLower)(`${title} ${fullText}`).replace(NOT_A_SIGNAL, ' ');
    const fire = FIRE_WORD.test(text);
    const strong = STRONG_RE.filter(({ re }) => re.test(text)).map(({ kw }) => kw);
    if (strong.length > 0) {
        return fire
            ? { wildfire: true, basis: 'strong', matched: strong }
            : { wildfire: false, basis: 'no_fire_word', matched: strong };
    }
    const weak = WEAK_RE.filter(({ re }) => re.test(text)).map(({ kw }) => kw);
    if (weak.length === 0)
        return { wildfire: false, basis: 'no_signal', matched: [] };
    if (BUILDING_OR_VEHICLE_IN_TITLE.test(titleLower)) {
        return { wildfire: false, basis: 'building_or_vehicle_title', matched: weak };
    }
    if (!fire)
        return { wildfire: false, basis: 'no_fire_word', matched: weak };
    return { wildfire: true, basis: 'weak', matched: weak };
}
