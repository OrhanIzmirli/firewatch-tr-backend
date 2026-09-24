import { turkishToLower } from '../utils/turkishText';

/**
 * Finds the district a news article is reporting FROM.
 *
 * The province matcher (officialStatusExtractor.mentionedCities) can afford
 * a bare substring test: there are 81 province names and none of them is an
 * ordinary word. There are ~970 district names and several of them are.
 * Measured on real copy, a bare match geocoded "13 araç birbirine girdi"
 * (thirteen VEHICLES collided) to Araç, Kastamonu, and every "Ege ve
 * Akdeniz" regional-outlook story to Akdeniz, Mersin. Of 13 such hits,
 * one was a real fire.
 *
 * So a district only counts when the text names it the way Turkish news
 * names a place it is reporting from: with a locative suffix ("Kaş'ta",
 * "Edremit'teki", "Silivri'de") or as "X ilçesi". The 89 articles that
 * passed this rule confirmed against the satellite at the same rate as the
 * unfiltered set, so it costs no recall.
 */

export interface DistrictRef {
  id: number;
  name: string;
  provinceId: number;
  provinceName: string;
  lat: number;
  lng: number;
}

export interface DistrictMention {
  district: DistrictRef;
  /** The surface form that matched, for the shadow report. */
  phrase: string;
}

/**
 * District names that are not place names in running text even with a
 * suffix ("merkez'de" = "in the centre"). Every province has one.
 */
const GENERIC_NAMES = new Set(['merkez']);

const TR_LETTER = 'a-z0-9ğüşıöç';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Locative: -da/-de/-ta/-te with the optional buffer -n- after a vowel
 * ("Kaş'ta", "Silivri'de", "Bodrum'da", "Edremit'te", "Ovacık'ta"), plus
 * -ki ("Kaş'taki"). The apostrophe is optional because some outlets drop
 * it. "ilçesi"/"ilçesinde" covers "Antalya'nın Kaş ilçesinde".
 */
function locativePattern(name: string): RegExp {
  const n = escapeRegExp(turkishToLower(name));
  return new RegExp(
    `(^|[^${TR_LETTER}])(${n}(?:['’]?n?[dt][ae](?:ki)?|\\s+il[çc]esi(?:n?[dt][ae](?:ki)?)?))(?=$|[^${TR_LETTER}])`
  );
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
export function mentionedDistricts(
  text: string,
  districts: readonly DistrictRef[],
  provinceNames: readonly string[] = []
): DistrictMention[] {
  const low = turkishToLower(text);
  const found: DistrictMention[] = [];

  for (const district of districts) {
    const lowName = turkishToLower(district.name);
    if (GENERIC_NAMES.has(lowName)) continue;
    const match = locativePattern(district.name).exec(low);
    if (match) found.push({ district, phrase: match[2] });
  }

  if (found.length <= 1 || provinceNames.length !== 1) return found;

  const wanted = turkishToLower(provinceNames[0]);
  const narrowed = found.filter(
    (m) => turkishToLower(m.district.provinceName) === wanted
  );
  return narrowed.length > 0 ? narrowed : found;
}

/**
 * Collapses mentions to a single district, or null when the text names
 * more than one distinct district (a roundup of several fires — refuse
 * rather than pick) or a homonym the province could not disambiguate.
 */
export function singleDistrict(mentions: DistrictMention[]): DistrictMention | null {
  if (mentions.length === 0) return null;
  const distinct = new Set(mentions.map((m) => m.district.id));
  return distinct.size === 1 ? mentions[0] : null;
}
