"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mentionedDistricts = mentionedDistricts;
exports.singleDistrict = singleDistrict;
const turkishText_1 = require("../utils/turkishText");
/**
 * District names that are not place names in running text even with a
 * suffix ("merkez'de" = "in the centre"). Every province has one.
 */
const GENERIC_NAMES = new Set(['merkez']);
const TR_LETTER = 'a-z0-9ğüşıöç';
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Locative: -da/-de/-ta/-te with the optional buffer -n- after a vowel
 * ("Kaş'ta", "Silivri'de", "Bodrum'da", "Edremit'te", "Ovacık'ta"), plus
 * -ki ("Kaş'taki"). The apostrophe is optional because some outlets drop
 * it. "ilçesi"/"ilçesinde" covers "Antalya'nın Kaş ilçesinde".
 */
function locativePattern(name) {
    const n = escapeRegExp((0, turkishText_1.turkishToLower)(name));
    return new RegExp(`(^|[^${TR_LETTER}])(${n}(?:['’]?n?[dt][ae](?:ki)?|\\s+il[çc]esi(?:n?[dt][ae](?:ki)?)?))(?=$|[^${TR_LETTER}])`);
}
/**
 * Every district the text names with a locative form. Callers decide what
 * more than one means; this function only finds them.
 *
 * `provinceNames` — the provinces the same text names (from
 * mentionedCities). When a district name exists in several provinces
 * ("Kemer" is in both Antalya and Burdur) and the article names one of
 * them, the others are dropped. If it names none, every homonym is
 * returned and the caller must refuse.
 */
function mentionedDistricts(text, districts, provinceNames = []) {
    const low = (0, turkishText_1.turkishToLower)(text);
    const found = [];
    for (const district of districts) {
        const lowName = (0, turkishText_1.turkishToLower)(district.name);
        if (GENERIC_NAMES.has(lowName))
            continue;
        const match = locativePattern(district.name).exec(low);
        if (match)
            found.push({ district, phrase: match[2] });
    }
    if (found.length <= 1 || provinceNames.length !== 1)
        return found;
    const wanted = (0, turkishText_1.turkishToLower)(provinceNames[0]);
    const narrowed = found.filter((m) => (0, turkishText_1.turkishToLower)(m.district.provinceName) === wanted);
    return narrowed.length > 0 ? narrowed : found;
}
/**
 * Collapses mentions to a single district, or null when the text names
 * more than one distinct district (a roundup of several fires — refuse
 * rather than pick) or a homonym the province could not disambiguate.
 */
function singleDistrict(mentions) {
    if (mentions.length === 0)
        return null;
    const distinct = new Set(mentions.map((m) => m.district.id));
    return distinct.size === 1 ? mentions[0] : null;
}
