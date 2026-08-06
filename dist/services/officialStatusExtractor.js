"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.assessRelevance = assessRelevance;
exports.extractStatusClaim = extractStatusClaim;
exports.mentionedCities = mentionedCities;
const turkishText_1 = require("../utils/turkishText");
/**
 * NEGATIVE AND IN-PROGRESS FORMS.
 *
 * These are matched BEFORE the positive ones and they veto the positive rule
 * for the same verb. This is the single most dangerous place in the file:
 * "kontrol altına alınamadı" is the exact opposite of "kontrol altına alındı",
 * and a substring search for the latter finds it inside the former. Getting
 * this backwards would report a raging fire as contained.
 *
 * Turkish builds these by inserting a negation morpheme between the passive
 * stem and the tense suffix:
 *
 *   al-ın-dı            alındı        "was taken (under control)"
 *   al-ın-a-ma-dı       alınamadı     "could not be taken"
 *   al-ın-ma-dı         alınmadı      "was not taken"
 *   söndür-ül-dü        söndürüldü    "was extinguished"
 *   söndür-ül-e-me-di   söndürülemedi "could not be extinguished"
 *
 * The patterns therefore match the stem plus an explicit (a)ma/(e)me before
 * the tense, rather than trying to exclude anything after the fact.
 */
const NEGATIVE_RULES = [
    {
        name: 'neg:kontrol-alinamadi',
        // alınamadı / alınamıyor / alınmadı / alınamamış / alınamayan
        // [ae]?m[aeıi] covers alınamadı, alınamıyor, alınmadı, alınamamış.
        // The old a?m[ae] could not reach the -mıyor present, so "kontrol
        // altına alınamıyor" — a fire explicitly NOT under control — matched
        // no negative rule and fell through to the positive ones.
        pattern: /kontrol\s+alt[ıi]na\s+al[ıi]n(?:[ae]?m[aeıi])\w*/,
        state: 'ongoing',
    },
    {
        name: 'neg:kontrol-altinda-degil',
        pattern: /kontrol\s+alt[ıi]nda\s+de[ğg]il/,
        state: 'ongoing',
    },
    {
        name: 'neg:sondurulemedi',
        // söndürülemedi / söndürülemiyor / söndürülmedi / söndürülememiş
        // Same fix plus the -eme- form: söndürülemedi is stem + e + me + di,
        // which a?m[ae] could not match at all. A missed negation here is the
        // worst failure this file can have — it turns "could not be
        // extinguished" into a candidate for "extinguished".
        pattern: /s[öo]nd[üu]r[üu]l(?:[ae]?m[aeıi])\w*/,
        state: 'ongoing',
    },
    {
        name: 'neg:sondurme-cabasi',
        // "söndürülmeye çalışılıyor", "söndürme çalışmaları sürüyor" — an attempt
        // in progress, NOT a result. Real wire copy uses this constantly and the
        // stem is identical to the success form.
        pattern: /s[öo]nd[üu]r(?:[üu]lmeye|meye|me)\s+(?:[çc]al[ıi][şs]|[çc]aba|faaliyet|[çc]al[ıi][şs]malar)\w*/,
        state: 'ongoing',
    },
    {
        name: 'neg:sondurulurken',
        // "söndürülürken" — while being extinguished; describes the middle of the
        // event, not its end.
        pattern: /s[öo]nd[üu]r[üu]l[üu]rken/,
        state: 'ongoing',
    },
];
/** Which positive rule each negative rule cancels. */
const VETOES = {
    'neg:kontrol-alinamadi': ['pos:kontrol-altina-alindi', 'pos:kontrol-altinda'],
    'neg:kontrol-altinda-degil': ['pos:kontrol-altina-alindi', 'pos:kontrol-altinda'],
    'neg:sondurulemedi': ['pos:sondurulu', 'pos:tamamen-sonduruldu'],
    'neg:sondurme-cabasi': ['pos:sondurulu', 'pos:tamamen-sonduruldu'],
    'neg:sondurulurken': ['pos:sondurulu', 'pos:tamamen-sonduruldu'],
};
const POSITIVE_RULES = [
    {
        name: 'pos:tamamen-sonduruldu',
        pattern: /tamamen\s+s[öo]nd[üu]r[üu]ld[üu]/,
        state: 'extinguished',
    },
    {
        name: 'pos:sondurulu',
        // söndürüldü / söndürülmüştür / söndürülmüş
        // No \b here: JavaScript word boundaries are ASCII-only, so \b after
        // "ü" never matches and a plain "söndürüldü." was silently
        // unrecognised — while "söndürülmüştür" (ASCII "r") matched fine. The
        // negative lookahead is the Turkish-aware equivalent, and it is what
        // lets the extinction rule outrank containment when a sentence
        // carries both.
        pattern: /s[öo]nd[üu]r[üu]l(?:d[üu]|m[üu][şs]t[üu]r|m[üu][şs])(?![a-zçğıöşü])/,
        state: 'extinguished',
    },
    {
        name: 'pos:kontrol-altina-alindi',
        // alındı / alınarak / alınan — all assert the control happened
        pattern: /kontrol\s+alt[ıi]na\s+al[ıi]n(?:d[ıi]|arak|an|m[ıi][şs])/,
        state: 'contained',
    },
    {
        name: 'pos:kontrol-altinda',
        pattern: /kontrol\s+alt[ıi]nda(?!\s+de[ğg]il)/,
        state: 'contained',
    },
    {
        name: 'pos:sogutma',
        // Cooling only starts once flames are down — a containment signal, never
        // an extinction one.
        pattern: /so[ğg]utma\s+(?:[çc]al[ıi][şs]malar|faaliyet|i[şs]lem)\w*/,
        state: 'contained',
    },
    {
        name: 'pos:mudahale-suruyor',
        pattern: /m[üu]dahale\s+(?:ediliyor|ediyor|s[üu]r[üu]yor|devam\s+ediyor|[çc]al[ıi][şs]malar[ıi]\s+s[üu]r)/,
        state: 'ongoing',
    },
    {
        name: 'pos:devam-ediyor',
        pattern: /yang[ıi]n\w*\s+(?:\w+\s+){0,3}?devam\s+ediyor/,
        state: 'ongoing',
    },
    {
        name: 'pos:yayiliyor',
        pattern: /(?:yay[ıi]l[ıi]yor|yay[ıi]lmaya\s+devam|s[ıi][çc]rad[ıi]|b[üu]y[üu]yor)/,
        state: 'ongoing',
    },
];
const STATE_STRENGTH = {
    ongoing: 1,
    contained: 2,
    extinguished: 3,
};
const VEGETATION_TERMS = /(orman|otluk|an[ıi]z|makilik|[öo]rt[üu]\s+yang[ıi]n|çal[ıi]l[ıi]k|çam|a[ğg]a[çc]l[ıi]k|milli\s+park|zeytinlik|bu[ğg]day)/;
const STRUCTURE_TERMS = /(tekne|gemi|yat|trafo|fabrika|atölye|apartman|bina|daire|ev\s+yang[ıi]n|i[şs]\s+yeri|ara[çc]|otomobil|kamyon|otob[üu]s|[çc]iftli[ğg]i|ah[ıi]r|depo|market|hastane|okul|baca|konteyner)/;
const FOREIGN_TERMS = /(bulgaristan|yunanistan|italya|ispanya|portekiz|fransa|almanya|kaliforniya|amerika|abd|kanada|avustralya|rusya|ukrayna|suriye|irak|iran|israil|f[ıi]rt[ıi]na\s+abd)/;
function assessRelevance(text) {
    const low = (0, turkishText_1.turkishToLower)(text);
    // "ateş" as well as "yangın": wire copy routinely writes "çöp alanından
    // sıçrayan ateş ormanlık alanı yaktı", which is a vegetation fire reported
    // without ever using the word yangın.
    if (!/(yang[ıi]n|ate[şs])/.test(low)) {
        return { relevant: false, reason: 'no_fire_word' };
    }
    if (FOREIGN_TERMS.test(low)) {
        return { relevant: false, reason: 'foreign_country' };
    }
    const vegetation = VEGETATION_TERMS.test(low);
    const structure = STRUCTURE_TERMS.test(low);
    // A fire that started in a rubbish tip and reached the forest is still a
    // vegetation fire, so vegetation wins when both appear.
    if (!vegetation && structure) {
        return { relevant: false, reason: 'structure_or_vehicle_fire' };
    }
    if (!vegetation) {
        return { relevant: false, reason: 'no_vegetation_context' };
    }
    return { relevant: true, reason: 'vegetation_fire' };
}
/**
 * Extracts the status claim, or null when nothing can be said safely.
 *
 * Note the deliberate asymmetry at the end: an extinction claim that has any
 * negative or in-progress rule firing anywhere in the same text is downgraded,
 * never published. Containment is downgraded the same way.
 */
function extractStatusClaim(text) {
    const low = (0, turkishText_1.turkishToLower)(text);
    const firedNegatives = [];
    const vetoed = new Set();
    for (const rule of NEGATIVE_RULES) {
        if (rule.pattern.test(low)) {
            firedNegatives.push(rule);
            for (const target of VETOES[rule.name] ?? [])
                vetoed.add(target);
        }
    }
    const candidates = [];
    const suppressed = [];
    for (const rule of POSITIVE_RULES) {
        const match = rule.pattern.exec(low);
        if (!match)
            continue;
        if (vetoed.has(rule.name)) {
            suppressed.push(`${rule.name} (vetoed)`);
            continue;
        }
        candidates.push({ rule, phrase: match[0] });
    }
    // Negative rules are themselves 'ongoing' evidence.
    for (const rule of firedNegatives) {
        const match = rule.pattern.exec(low);
        if (match)
            candidates.push({ rule, phrase: match[0] });
    }
    if (candidates.length === 0)
        return null;
    candidates.sort((a, b) => STATE_STRENGTH[b.rule.state] - STATE_STRENGTH[a.rule.state]);
    const strongest = candidates[0];
    // Final asymmetric guard: never publish the strongest state while any
    // contradicting in-progress evidence sits in the same article.
    if (strongest.rule.state !== 'ongoing' && firedNegatives.length > 0) {
        const fallback = candidates.find((c) => c.rule.state === 'ongoing');
        if (fallback) {
            return {
                state: 'ongoing',
                phrase: fallback.phrase,
                rule: fallback.rule.name,
                suppressed: [...suppressed, `${strongest.rule.name} (contradicted)`],
            };
        }
        return null;
    }
    return {
        state: strongest.rule.state,
        phrase: strongest.phrase,
        rule: strongest.rule.name,
        suppressed,
    };
}
/**
 * Province names mentioned in the text. More than one means the article is
 * probably covering several fires, which is a reason to refuse a match rather
 * than to pick one.
 */
function mentionedCities(text, cityNames) {
    const low = (0, turkishText_1.turkishToLower)(text);
    const found = [];
    for (const name of cityNames) {
        const lowName = (0, turkishText_1.turkishToLower)(name);
        // Turkish suffixes attach directly ("Balıkesir'in", "Muğla'da"), so a
        // trailing word boundary is wrong; a leading one is enough to stop
        // "Adana" matching inside another word.
        const pattern = new RegExp(`(^|[^a-z0-9ğüşıöç])${escapeRegExp(lowName)}`);
        if (pattern.test(low))
            found.push(name);
    }
    return found;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
