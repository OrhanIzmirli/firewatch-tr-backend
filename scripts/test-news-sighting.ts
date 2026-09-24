/**
 * Unit test for the district matcher behind newsSightingJob.
 *
 * Needs no database: every case is a headline taken from (or shaped like)
 * real wire copy, run against a small fixture gazetteer that includes the
 * homonyms and false-friend names the matcher exists to handle.
 *
 *   npm run test:news-sighting
 *
 * The job's database path (creation, corroboration, confirmation, expiry)
 * is exercised by running it once against a database with migrations
 * 008/009 applied and reading /api/health/pipeline and
 * /api/admin/news-sightings; there is no disposable-DB harness for it yet.
 */
import assert from 'node:assert';
import {
  DistrictRef,
  mentionedDistricts,
  singleDistrict,
} from '../src/services/placeMention';
import {
  assessRelevance,
  extractStatusClaim,
  mentionedCities,
} from '../src/services/officialStatusExtractor';

const PROVINCES = ['Antalya', 'Balıkesir', 'Van', 'Burdur', 'Kastamonu', 'Mersin', 'İstanbul', 'Muğla'];

let nextId = 1;
const d = (name: string, provinceName: string): DistrictRef => ({
  id: nextId++,
  name,
  provinceId: PROVINCES.indexOf(provinceName) + 1,
  provinceName,
  lat: 0,
  lng: 0,
});

const DISTRICTS: DistrictRef[] = [
  d('Kaş', 'Antalya'),
  d('Kemer', 'Antalya'),
  d('Kemer', 'Burdur'),
  d('Edremit', 'Balıkesir'),
  d('Edremit', 'Van'),
  d('Araç', 'Kastamonu'),
  d('Akdeniz', 'Mersin'),
  d('Silivri', 'İstanbul'),
  d('Bodrum', 'Muğla'),
  d('Merkez', 'Burdur'),
];

interface Case {
  title: string;
  /** Expected "District (Province)", or null for refuse/none. */
  expect: string | null;
  /** Why this case exists. */
  because: string;
}

const CASES: Case[] = [
  {
    title: "Antalya'nın Kaş ilçesinde orman yangını",
    expect: 'Kaş (Antalya)',
    because: '"X ilçesinde" form',
  },
  {
    title: "Kaş'ta orman yangınıyla mücadele ikinci gününde",
    expect: 'Kaş (Antalya)',
    because: 'locative with apostrophe',
  },
  {
    title: "Kaş'taki orman yangınına müdahale sürüyor",
    expect: 'Kaş (Antalya)',
    because: '-taki form',
  },
  {
    title: "Silivri'de otluk alanda yangın",
    expect: 'Silivri (İstanbul)',
    because: 'plain -de',
  },
  {
    title: 'Bodrumda makilik alanda yangın',
    expect: 'Bodrum (Muğla)',
    because: 'apostrophe dropped by the outlet',
  },
  {
    title: "Balıkesir'de orman yangını: Edremit'te alevler evlere yaklaştı",
    expect: 'Edremit (Balıkesir)',
    because: 'homonym (Edremit is also in Van) resolved by the named province',
  },
  {
    title: "Edremit'te orman yangını",
    expect: null,
    because: 'homonym with no province named — refuse, do not pick',
  },
  {
    title: "Antalya Kemer'de orman yangını",
    expect: 'Kemer (Antalya)',
    because: 'homonym (Kemer is also in Burdur) resolved by province',
  },
  {
    title: "Kaş'ta ve Kemer'de orman yangını",
    expect: null,
    because: 'two districts is a roundup — refuse',
  },
  {
    title: 'Anız yangını kazaya neden oldu: 13 araç birbirine girdi',
    expect: null,
    because: '"araç" here means vehicle; no locative, no match',
  },
  {
    title: "Araç'ta anız yangını ormana sıçradı",
    expect: 'Araç (Kastamonu)',
    because: 'the same word WITH a locative is the place',
  },
  {
    title: 'Uzman uyardı: yangın riski yalnızca Ege ve Akdeniz ile sınırlı değil',
    expect: null,
    because: 'the sea/region, not the Mersin district — no locative',
  },
  {
    title: "Merkez'de otluk alanda yangın",
    expect: null,
    because: '"merkez" is generic even with a suffix',
  },
  {
    title: "Muğla'da orman yangını",
    expect: null,
    because: 'province only — too coarse for a sighting',
  },
];

let failures = 0;

console.log('--- district matcher ---');
for (const c of CASES) {
  const provinces = mentionedCities(c.title, PROVINCES);
  const mention = singleDistrict(mentionedDistricts(c.title, DISTRICTS, provinces));
  const got = mention ? `${mention.district.name} (${mention.district.provinceName})` : null;
  const ok = got === c.expect;
  if (!ok) failures++;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${c.title.slice(0, 60).padEnd(60)} -> ${String(got).padEnd(22)} ` +
      `${ok ? '' : `expected ${c.expect} `}(${c.because})`
  );
}

console.log('\n--- gates the job applies before matching ---');
const gates: Array<{ title: string; check: () => boolean; because: string }> = [
  {
    title: "Tunus'ta orman yangınları Akdeniz'in doğal mirasını tehdit ediyor",
    check: () => !assessRelevance("Tunus'ta orman yangınları Akdeniz'in doğal mirasını tehdit ediyor").relevant,
    because: 'Tunisia is foreign; used to pass and geocode to Akdeniz, Mersin',
  },
  {
    title: 'vefasız dost ormanı yaktı',
    check: () => assessRelevance('vefasız dost ormanı yaktı: yangın büyüyor').relevant,
    because: '"fas" (Morocco) is not in FOREIGN_TERMS — it would match inside "vefasız"',
  },
  {
    title: "Kaş'taki orman yangını kontrol altına alındı",
    check: () => {
      const claim = extractStatusClaim("Kaş'taki orman yangını kontrol altına alındı");
      return claim !== null && claim.state !== 'ongoing';
    },
    because: 'contained/extinguished claims are excluded from sightings',
  },
  {
    title: "Kaş'taki orman yangınına müdahale ediliyor",
    check: () => extractStatusClaim("Kaş'taki orman yangınına müdahale ediliyor")?.state === 'ongoing',
    because: 'ongoing passes',
  },
  {
    title: "Kaş'ta ormanlık alanda yangın çıktı",
    check: () => extractStatusClaim("Kaş'ta ormanlık alanda yangın çıktı") === null,
    because: 'no claim at all passes too (31% confirmed in backtest)',
  },
];
for (const g of gates) {
  const ok = g.check();
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${g.title.slice(0, 60).padEnd(60)} (${g.because})`);
}

assert.ok(true);
if (failures > 0) {
  console.log(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nALL PASS');
