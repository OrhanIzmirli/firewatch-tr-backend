/**
 * Unit test for the Turkey gate on wildfire news (utils/newsGeography.ts)
 * and its place in checkRelevance (utils/newsRelevance.ts).
 *
 *   npm run test:news-geography
 *
 * Headlines are real items from the news table (id in the comment),
 * checked on 2026-11-06, plus a few made-up neighbour cases for the
 * exception that the stored data does not yet exercise.
 */
import assert from 'node:assert';
import { assessTurkey } from '../src/utils/newsGeography';
import { checkRelevance } from '../src/utils/newsRelevance';

let failures = 0;
const b = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

const TURKEY: [string, string, string?][] = [
  ['#2130', "Bodrum'da otluk alanda çıkan yangın, ormana sıçradı"],
  ['#2522', "Adıyaman'da orman yangını: Havadan ve karadan müdahale başladı"],
  ['#2383', "Muğla, Antalya ve Kütahya'da orman yangını! Seydikemer'de kara yolu ulaşıma kapatıldı"],
  ['#1629', 'Uzmanlar Temmuz sonrasına dikkat çekti: Şimdiye kadar hiç görülmeyen sıcaklıklar kapıda'],
  // a weather idiom, not a place
  ['#2793', "Prof. Dr. Türkeş'ten 'Afrika sıcağı' uyarısı: Sıcaklıklar 3 ila 6 derece artacak"],
  // neighbour fires that reach Turkey
  ['n1', "Yunanistan'daki orman yangını Edirne'den görüldü", "Dedeağaç yakınlarındaki yangının dumanı Meriç'in Türkiye tarafından izlendi."],
  ['n2', "Bulgaristan'daki yangın Türkiye sınırına yaklaştı", "Kırklareli sınırındaki ekipler alarma geçti."],
  ['n3', "Suriye'nin Lazkiye kentindeki orman yangınına Türkiye'den uçaklar gönderildi", ''],
  ['n4', "Midilli'deki yangının külleri Ayvalık'a ulaştı", "Balıkesir'in Ayvalık ilçesinde rüzgarla gelen kül yağdı."],
];

const ABROAD: [string, string, string?][] = [
  ['#3626', "Endonezya'da orman yangınları nedeniyle 333 binden fazla kişide akut solunum yolu enfeksiyonu saptandı"],
  ['#2215', 'İspanya\'da "yılın en büyük orman yangınında" 12 bin hektarlık alan kül oldu'],
  ['#2174', "Kanada'daki orman yangınlarının dumanı ABD'nin kuzeydoğusuna ulaştı"],
  ['#2983', "İtalya'nın Sicilya Adası'ndaki orman yangını Taormina yakınlarındaki bazı evleri tehdit ediyor"],
  ['#2073', 'Avrupa, aşırı sıcaklar ve orman yangınlarıyla mücadele ediyor'],
  // neighbours, but nothing ties the fire to Turkey
  ['#1975', "Midilli Adası'nda makilik alanda yangın çıktı"],
  ['#2470', "Bulgaristan'da yaklaşık 2 bin dönüm alanı etkileyen yangına müdahale ediliyor"],
  // a far country stays out even when Turkey is named
  ['f1', "Türkiye Kanada'daki orman yangınları için yardım gönderdi", ''],
  // "sınırlı" is not the border
  ['f2', "Yunanistan'da sınırlı sayıda ekip yangına müdahale ediyor", ''],
];

for (const [id, title, summary] of TURKEY) {
  b(`turkey ${id} ${title.slice(0, 55)}`, () => {
    const v = assessTurkey(title, `${title} ${summary ?? ''}`);
    assert.ok(v.turkey, `abroad as ${v.basis}: ${v.matched.join(',')}`);
  });
}
for (const [id, title, summary] of ABROAD) {
  b(`abroad ${id} ${title.slice(0, 55)}`, () => {
    const v = assessTurkey(title, `${title} ${summary ?? ''}`);
    assert.ok(!v.turkey, `kept as ${v.basis}: ${v.matched.join(',')}`);
  });
}

b('place names are whole words: "iranı", "için", "sınırlı" do not count', () => {
  assert.strictEqual(assessTurkey('Yangın alanı iranı aştı için', '').basis, 'no_foreign_place');
  assert.strictEqual(assessTurkey("İran'da orman yangını", '').basis, 'neighbour_only');
  assert.strictEqual(assessTurkey("İran'da orman yangını sınırda", '').basis, 'neighbour_reaching_turkey');
});

b('checkRelevance drops a foreign wildfire as foreign, keeps a Turkish one', () => {
  assert.deepStrictEqual(checkRelevance("Endonezya'da orman yangınları sürüyor", "Endonezya'da orman yangınları sürüyor"), { relevant: false, reason: 'foreign' });
  assert.deepStrictEqual(checkRelevance("Muğla'da orman yangını", "Muğla'da orman yangını"), { relevant: true, reason: 'ok' });
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
