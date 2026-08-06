/**
 * Tests for the Turkish status extractor.
 *
 * Run: npm run test:official-status
 *
 * The negation cases are the point of this file. "kontrol altına alınamadı"
 * means the fire is NOT under control; a substring search for "kontrol altına
 * alındı" finds it inside that phrase and reports the exact opposite. Every
 * negative form below is a real construction that appears in Turkish wire
 * copy.
 */
import assert from 'node:assert';
import {
  extractStatusClaim,
  assessRelevance,
  mentionedCities,
} from '../src/services/officialStatusExtractor';

interface Case {
  text: string;
  expect: 'ongoing' | 'contained' | 'extinguished' | null;
  why: string;
}

const CASES: Case[] = [
  // ---- the negation trap, both directions -------------------------------
  { text: 'Yangın kontrol altına alındı.', expect: 'contained', why: 'positive containment' },
  { text: 'Yangın kontrol altına alınamadı.', expect: 'ongoing', why: 'NEGATED containment' },
  { text: 'Yangın henüz kontrol altına alınamadı.', expect: 'ongoing', why: 'negated + henüz' },
  { text: 'Yangın kontrol altına alınamıyor.', expect: 'ongoing', why: 'negated present' },
  { text: 'Yangın kontrol altına alınmadı.', expect: 'ongoing', why: 'plain negation' },
  { text: 'Yangın kontrol altında değil.', expect: 'ongoing', why: 'değil negation' },

  { text: 'Yangın söndürüldü.', expect: 'extinguished', why: 'positive extinction' },
  { text: 'Yangın tamamen söndürüldü.', expect: 'extinguished', why: 'emphatic extinction' },
  { text: 'Yangın söndürülemedi.', expect: 'ongoing', why: 'NEGATED extinction' },
  { text: 'Yangın söndürülemiyor.', expect: 'ongoing', why: 'negated present' },
  { text: 'Yangın söndürülmedi.', expect: 'ongoing', why: 'plain negation' },

  // ---- in-progress forms that look like success -------------------------
  {
    text: 'Yangın havadan ve karadan müdahaleyle söndürülmeye çalışılıyor.',
    expect: 'ongoing',
    why: 'attempt in progress, not a result (real AA wording)',
  },
  {
    text: 'Teknede çıkan yangın ekiplerin müdahalesiyle söndürülürken hasar oluştu.',
    expect: 'ongoing',
    why: 'söndürülürken = while being put out',
  },
  {
    text: 'Söndürme çalışmaları sürüyor.',
    expect: 'ongoing',
    why: 'extinguishing work ongoing',
  },

  // ---- real sentences from the live feed --------------------------------
  {
    text: 'Ekiplerin müdahalesi sonucu yangın kontrol altına alınarak söndürüldü.',
    expect: 'extinguished',
    why: 'both states in one sentence, strongest wins',
  },
  {
    text: 'Kısa sürede kontrol altına alınan yangında trafoda hasar meydana geldi.',
    expect: 'contained',
    why: 'participle form alınan',
  },
  {
    text: "Balıkesir'in Manyas ilçesinde çıkan orman yangınına müdahale ediliyor.",
    expect: 'ongoing',
    why: 'response under way',
  },
  {
    text: 'Soğutma çalışmaları devam ediyor.',
    expect: 'contained',
    why: 'cooling implies flames are down',
  },

  // ---- contradiction inside one article ---------------------------------
  {
    text: 'Yangının söndürüldüğü açıklandı ancak alevler yayılmaya devam ediyor.',
    expect: 'ongoing',
    why: 'contradicted extinction must never publish as extinguished',
  },

  // ---- nothing to say ---------------------------------------------------
  { text: 'Orman yangınlarına karşı bilinçlendirme toplantısı yapıldı.', expect: null, why: 'no status phrase' },
];

let failures = 0;

console.log('--- status extraction ---');
for (const testCase of CASES) {
  const claim = extractStatusClaim(testCase.text);
  const actual = claim?.state ?? null;
  const ok = actual === testCase.expect;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  expected=${String(testCase.expect).padEnd(12)} ` +
      `got=${String(actual).padEnd(12)} rule=${(claim?.rule ?? '-').padEnd(28)} ${testCase.why}`
  );
  if (!ok) console.log(`      text: ${testCase.text}`);
}

console.log('\n--- relevance ---');
const RELEVANCE: Array<[string, boolean, string]> = [
  ["Manyas'ta orman yangını çıktı", true, 'forest fire'],
  ['Tunceli’de otluk alanda çıkan yangın ormana sıçradı', true, 'grass -> forest'],
  ['Çöp alanından sıçrayan ateş ormanlık alanı yaktı', true, 'rubbish tip but reached forest'],
  ['Marmaris’te demirli yelkenli teknede yangın çıktı', false, 'boat fire'],
  ['Trafoda yangın çıktı, vatandaşlar ATM’den para çekti', false, 'transformer fire'],
  ['Tavuk çiftliğinde yangın: Ekipler müdahale ediyor', false, 'farm building fire'],
  ['Bulgaristan’da 2 bin dönüm alanı etkileyen orman yangını', false, 'abroad'],
  ['Ahırkapı açıklarında gemi yangını', false, 'ship fire'],
];
for (const [text, expected, why] of RELEVANCE) {
  const result = assessRelevance(text);
  const ok = result.relevant === expected;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  relevant=${String(result.relevant).padEnd(5)} ` +
      `reason=${result.reason.padEnd(26)} ${why}`
  );
}

console.log('\n--- city mentions ---');
const CITIES = ['Balıkesir', 'Muğla', 'İzmir', 'Adana', 'Ankara'];
const CITY_CASES: Array<[string, string[], string]> = [
  ["Balıkesir'in Manyas ilçesinde yangın", ['Balıkesir'], 'suffix -in'],
  ['Muğla’da orman yangını', ['Muğla'], 'apostrophe suffix'],
  ['İzmir ve Muğla’da yangınlar', ['Muğla', 'İzmir'], 'two provinces -> ambiguous later'],
  ['Adanalı vatandaş konuştu', ['Adana'], 'prefix match is accepted (known limitation)'],
  ['Ankara Büyükşehir açıklama yaptı', ['Ankara'], 'plain mention'],
];
for (const [text, expected, why] of CITY_CASES) {
  const found = mentionedCities(text, CITIES).sort();
  const ok = JSON.stringify(found) === JSON.stringify([...expected].sort());
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  found=${JSON.stringify(found).padEnd(24)} ${why}`
  );
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
assert.strictEqual(failures, 0, `${failures} test(s) failed`);
