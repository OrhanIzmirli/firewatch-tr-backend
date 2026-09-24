"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeDistrictName = normalizeDistrictName;
exports.stripMerkezSuffix = stripMerkezSuffix;
exports.matchDistrictName = matchDistrictName;
const turkishText_1 = require("../utils/turkishText");
/** English exonyms and one-off spellings the generic rules cannot reach. */
const ALIASES = {
    imbros: 'gökçeada',
    princeislands: 'adalar',
    karakeçeli: 'karakeçili',
};
/** Lower-case Turkish, circumflexes folded, everything but letters removed. */
function normalizeDistrictName(value) {
    return (0, turkishText_1.turkishToLower)(value.normalize('NFC'))
        .replace(/â/g, 'a')
        .replace(/î/g, 'i')
        .replace(/û/g, 'u')
        .replace(/[^a-zçğıöşü]/g, '');
}
/** Folds the Turkish letters to ASCII so "Ulukisla" meets "Ulukışla". */
function asciiFold(normalized) {
    return normalized
        .replace(/ç/g, 'c')
        .replace(/ğ/g, 'g')
        .replace(/ı/g, 'i')
        .replace(/ö/g, 'o')
        .replace(/ş/g, 's')
        .replace(/ü/g, 'u');
}
// [iİ]: the regex i flag does not fold capital dotted İ (U+0130) to i, so
// "(Merkez İlçe)" needs the letter spelled out.
const MERKEZ_SUFFIX = /\s*(\(\s*merkez(?:\s+[iİ]lçe)?\s*\)|merkezi|merkez(?:\s+[iİ]lçe)?|district)\s*$/i;
/**
 * Strips a trailing "merkez"-style token and returns the base name, or null
 * when the name carries no such token. "Elazığ merkez" → "Elazığ";
 * "Kilis (merkez)" → "Kilis"; "Giresun District" → "Giresun".
 */
function stripMerkezSuffix(shapeName) {
    const m = MERKEZ_SUFFIX.exec(shapeName);
    if (!m || m.index === 0)
        return null;
    return shapeName.slice(0, m.index).trim();
}
function uniqueByName(candidates, normalizedName, fold) {
    const key = fold ? asciiFold(normalizedName) : normalizedName;
    const hits = candidates.filter((d) => {
        const n = normalizeDistrictName(d.name);
        return (fold ? asciiFold(n) : n) === key;
    });
    return hits.length === 1 ? hits[0] : null;
}
/**
 * Resolves one polygon name against the districts of its province.
 * `provinceDistricts` must already be filtered to that province.
 */
function matchDistrictName(shapeName, provinceName, provinceDistricts) {
    const province = normalizeDistrictName(provinceName);
    const raw = normalizeDistrictName(shapeName);
    // 1. Exact, then ASCII-folded, on the name as written.
    const exact = uniqueByName(provinceDistricts, raw, false);
    if (exact)
        return exact;
    const folded = uniqueByName(provinceDistricts, raw, true);
    if (folded)
        return folded;
    // 2. Explicit aliases.
    const alias = ALIASES[raw];
    if (alias) {
        const hit = uniqueByName(provinceDistricts, alias, false);
        if (hit)
            return hit;
    }
    // 3. "<Province> merkez" and variants → Merkez; "<District> Merkez" → District.
    const base = stripMerkezSuffix(shapeName);
    if (base !== null) {
        const baseNorm = normalizeDistrictName(base);
        if (baseNorm === province || asciiFold(baseNorm) === asciiFold(province)) {
            return uniqueByName(provinceDistricts, 'merkez', false);
        }
        const asDistrict = uniqueByName(provinceDistricts, baseNorm, false) ??
            uniqueByName(provinceDistricts, baseNorm, true);
        if (asDistrict)
            return asDistrict;
    }
    // 4. The bare province name ("Ardahan") is its Merkez district.
    if (raw === province || asciiFold(raw) === asciiFold(province)) {
        return uniqueByName(provinceDistricts, 'merkez', false);
    }
    return null;
}
