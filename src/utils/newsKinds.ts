import { assessTurkey } from './newsGeography';
import { turkishToLower } from './turkishText';

/**
 * What a headline is about. Forest fires are the app's main subject; the
 * other kinds keep the news screen useful in winter, when there are few fires.
 */
export type NewsKind = 'fire' | 'field' | 'recovery' | 'preparation' | 'nature';

const RECOVERY = /ağaçlandır|fidan dik|fidan dağıt|fidanlar? toprakla|hatıra orman|yeniden yeşer|orman.*rehabilitasyon|yanan alan/;
const PREPARATION = /yangın (tatbikat|eğitim|sezon|önlem|hazırlı)|orman yangın.*(tatbikat|eğitim|önlem|hazırlı)|yangın gözetleme|yangın kule|arazöz.*(teslim|eğitim)|orman.*(tatbikat)/;
const NATURE = /yaban hayat|yaban keçi|milli park|tabiat park|doğa koruma|orman köylü|orman haftası|orman kahraman|ormancı/;
const FIELD = /anız|otluk|tarla|ot yangın|ekili alan|tarım alan|örtü yangın|çöplük|bahçe yangın/;
const FIRE = /yangın|alev/;
const BLOCKED = /cinayet|kaza yaptı|maç|seçim|bakan.*istifa/;

/** Null when the headline is about none of these. */
export function newsKind(title: string): NewsKind | null {
  const t = turkishToLower(title);
  if (BLOCKED.test(t)) return null;
  if (RECOVERY.test(t)) return 'recovery';
  if (PREPARATION.test(t)) return 'preparation';
  if (FIELD.test(t) && FIRE.test(t) && !/orman yangın/.test(t)) return 'field';
  if (/orman/.test(t) && FIRE.test(t)) return 'fire';
  if (NATURE.test(t)) return 'nature';
  return FIRE.test(t) ? 'fire' : null;
}

/** Recovery, preparation or nature news about Turkey: welcome in the feed even with no fire. */
export function isGreenStory(title: string): boolean {
  const kind = newsKind(title);
  return (kind === 'recovery' || kind === 'preparation' || kind === 'nature') && assessTurkey(title, title).turkey;
}
