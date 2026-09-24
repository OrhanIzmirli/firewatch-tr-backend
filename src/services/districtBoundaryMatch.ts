import { turkishToLower } from '../utils/turkishText';

/**
 * Matches geoBoundaries TUR ADM2 polygon names to our turkey_districts rows.
 *
 * geoBoundaries names come from OpenStreetMap and are inconsistent in a
 * small number of well-understood ways, all seen in the 2021 release:
 *
 *   "Elazığ merkez", "Kilis (merkez)", "Bolu Merkez", "Rize merkezi",
 *   "Afyonkarahisar (Merkez İlçe)", "Giresun District", "Ardahan"
 *                                        → our "Merkez" in that province
 *   "Gediz Merkez"                       → our "Gediz"
 *   "Imbros", "Prince Islands"           → Gökçeada, Adalar (English exonyms)
 *   "Ilıç", "Ulukisla", "Ayvacik", "Bahşılı", "İbradi", "Karakeçeli"
 *                                        → dotted/dotless-i and spelling drift
 *   "Şarkîkaraağaç"                      → circumflex
 *
 * Matching is always WITHIN a province: 23 district names repeat across
 * provinces (Kemer, Edremit, Yenişehir…), so the caller must first decide
 * which province a polygon belongs to (the seed does it with the ADM1
 * polygons). Within a province a name is unique.
 *
 * REFUSE-OVER-GUESS: a name that matches nothing, or more than one row,
 * returns null. The seed reports it; a human adds an alias. Nothing here
 * picks "the closest".
 */

export interface DistrictNameRef {
  id: number;
  name: string;
  provinceName: string;
}

/** English exonyms and one-off spellings the generic rules cannot reach. */
const ALIASES: Record<string, string> = {
  imbros: 'gökçeada',
  princeislands: 'adalar',
  karakeçeli: 'karakeçili',
};

/** Lower-case Turkish, circumflexes folded, everything but letters removed. */
export function normalizeDistrictName(value: string): string {
  return turkishToLower(value.normalize('NFC'))
    .replace(/â/g, 'a')
    .replace(/î/g, 'i')
    .replace(/û/g, 'u')
    .replace(/[^a-zçğıöşü]/g, '');
}

/** Folds the Turkish letters to ASCII so "Ulukisla" meets "Ulukışla". */
function asciiFold(normalized: string): string {
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
const MERKEZ_SUFFIX =
  /\s*(\(\s*merkez(?:\s+[iİ]lçe)?\s*\)|merkezi|merkez(?:\s+[iİ]lçe)?|district)\s*$/i;

/**
 * Strips a trailing "merkez"-style token and returns the base name, or null
 * when the name carries no such token. "Elazığ merkez" → "Elazığ";
 * "Kilis (merkez)" → "Kilis"; "Giresun District" → "Giresun".
 */
export function stripMerkezSuffix(shapeName: string): string | null {
  const m = MERKEZ_SUFFIX.exec(shapeName);
  if (!m || m.index === 0) return null;
  return shapeName.slice(0, m.index).trim();
}

function uniqueByName(
  candidates: readonly DistrictNameRef[],
  normalizedName: string,
  fold: boolean
): DistrictNameRef | null {
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
export function matchDistrictName(
  shapeName: string,
  provinceName: string,
  provinceDistricts: readonly DistrictNameRef[]
): DistrictNameRef | null {
  const province = normalizeDistrictName(provinceName);
  const raw = normalizeDistrictName(shapeName);

  // 1. Exact, then ASCII-folded, on the name as written.
  const exact = uniqueByName(provinceDistricts, raw, false);
  if (exact) return exact;
  const folded = uniqueByName(provinceDistricts, raw, true);
  if (folded) return folded;

  // 2. Explicit aliases.
  const alias = ALIASES[raw];
  if (alias) {
    const hit = uniqueByName(provinceDistricts, alias, false);
    if (hit) return hit;
  }

  // 3. "<Province> merkez" and variants → Merkez; "<District> Merkez" → District.
  const base = stripMerkezSuffix(shapeName);
  if (base !== null) {
    const baseNorm = normalizeDistrictName(base);
    if (baseNorm === province || asciiFold(baseNorm) === asciiFold(province)) {
      return uniqueByName(provinceDistricts, 'merkez', false);
    }
    const asDistrict =
      uniqueByName(provinceDistricts, baseNorm, false) ??
      uniqueByName(provinceDistricts, baseNorm, true);
    if (asDistrict) return asDistrict;
  }

  // 4. The bare province name ("Ardahan") is its Merkez district.
  if (raw === province || asciiFold(raw) === asciiFold(province)) {
    return uniqueByName(provinceDistricts, 'merkez', false);
  }

  return null;
}
