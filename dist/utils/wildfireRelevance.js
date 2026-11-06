"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VEGETATION_BURNED = exports.BUILDING_OR_VEHICLE_IN_TITLE = void 0;
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
 * A title that names a building or vehicle is a building or vehicle fire
 * until the text says vegetation burned (VEGETATION_BURNED): "orman
 * yangını", "ormana sıçradı", "4 dönüm alan"... Bare "orman" is then only
 * the place: a car that burned "in the forest" (#3736, #3739) or a truck
 * trailer on a forest road (#2152) is not a wildfire, while "kamyondaki
 * yangın ormana sıçradı" (#2748) is. "sıçramadan söndürüldü" is not a
 * spread, and a "muhtemel orman yangınının önüne geçildi" (#3694) is a
 * wildfire that did not happen (PREVENTED).
 *
 * Keywords match only at the start of a word: bare "orman" is inside
 * "performans" and "mera" inside "kamera".
 *
 * Measured 2026-11-06 on the 1,493 stored news items: 436 pass the
 * scraper whitelist and this gate. Known misses are headlines that name
 * only a place ("Muğla Seydikemer'de çıkan yangın Kaş'a sıçradı", "Ege'de
 * peş peşe yangınlar") with no vegetation word in title or summary.
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
/** Building, vehicle or facility named in a title. */
exports.BUILDING_OR_VEHICLE_IN_TITLE = /(^|[\s'’"(])(ev|evi|evde|evler|evleri|evinde|bungalov\S*|villa\S*|yazlık\S*|kulübe\S*|fabrika\S*|apartman\S*|daire\S*|bina\S*|otomobil\S*|araç\S*|aracı|tır|tır\S*|otobüs\S*|minibüs\S*|kamyon\S*|tanker\S*|traktör\S*|motosiklet\S*|depo\S*|baraka\S*|ahır\S*|samanlık\S*|işyeri\S*|iş yeri\S*|market\S*|mağaza\S*|tesis\S*|atölye\S*|restoran\S*|otel\S*|okul\S*|hastane\S*|cami\S*|tekne\S*|gemi\S*|uçak|jet|trafo\S*|baz istasyon\S*|plaza\S*|gecekondu\S*|konteyner\S*|çatı\S*)(?=$|[\s,.!?:;'’"):])/;
/** Lowercase Turkish letters and digits: a keyword must not follow one. */
const WORD_CHAR = 'a-zçğıöşüâîû0-9';
/**
 * Vegetation actually burned: a vegetation-fire noun, an area in
 * hectares/dönüm, or fire spreading *to* vegetation in a finished form
 * ("ormana sıçradı", "tarlaya yayılan"). "sıçramadan", "sıçramasını
 * önledi" and "ulaşmadan" do not match.
 */
const SPREAD_TARGET = '(ormana|ormanlık alana|ormanlık bölgeye|makiliğe|makilik alana|zeytinliğe|zeytinlik alana|tarlaya|tarlalara|anıza|anızlara|otluk alana|otluğa|ağaçlık alana|araziye|çalılığa|çalılık alana|sazlığa|sazlık alana|fundalığa|meraya|bahçeye|bahçelere|ekili alana|ekinlere|bağlara|bağlık alana)';
const SPREAD_VERB = '(sıçra|yayıl|atla|ulaş)(dı|dığı|yan|an|mış|yarak|arak|yıp|ıp)';
exports.VEGETATION_BURNED = new RegExp(`orman yangın|örtü yangın|anız yangın|makilik yangın|zeytinlik yangın|arazi yangın|otluk yangın|tarla yangın|ekin yangın` +
    `|(^|[^${WORD_CHAR}])(hektar|dönüm)` +
    `|${SPREAD_TARGET} ${SPREAD_VERB}`);
/**
 * A wildfire that was prevented or merely possible, removed before
 * VEGETATION_BURNED is tested: "muhtemel bir orman yangınının önüne
 * geçildi", "orman yangını riski".
 */
const PREVENTED = /(muhtemel|olası) (bir )?(orman|örtü|anız) yangın\S*|(orman|örtü|anız) yangın\S* (önüne geçil|önlen|engellen|riski|tehlikesi|ihtimali|çıkmasını önle)\S*/g;
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
    const namedStructure = exports.BUILDING_OR_VEHICLE_IN_TITLE.test(titleLower);
    const strong = STRONG_RE.filter(({ re }) => re.test(text)).map(({ kw }) => kw);
    if (strong.length > 0) {
        if (!fire)
            return { wildfire: false, basis: 'no_fire_word', matched: strong };
        if (namedStructure && !exports.VEGETATION_BURNED.test(text.replace(PREVENTED, ' '))) {
            return { wildfire: false, basis: 'building_or_vehicle_title', matched: strong };
        }
        return { wildfire: true, basis: 'strong', matched: strong };
    }
    const weak = WEAK_RE.filter(({ re }) => re.test(text)).map(({ kw }) => kw);
    if (weak.length === 0)
        return { wildfire: false, basis: 'no_signal', matched: [] };
    if (namedStructure) {
        return { wildfire: false, basis: 'building_or_vehicle_title', matched: weak };
    }
    if (!fire)
        return { wildfire: false, basis: 'no_fire_word', matched: weak };
    return { wildfire: true, basis: 'weak', matched: weak };
}
