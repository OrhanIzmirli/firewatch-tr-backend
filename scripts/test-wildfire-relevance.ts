/**
 * Unit test for the wildfire gate on scraped news (utils/wildfireRelevance.ts).
 *
 *   npm run test:wildfire-relevance
 *
 * Every title below is a real headline from the news table (id in the
 * comment), checked on 2026-11-06. The gate must keep the wildfire stories
 * and drop building/vehicle fires, weather and unrelated items.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assessWildfire } from '../src/utils/wildfireRelevance';

let failures = 0;
const b = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

const KEEP: [number, string, string?][] = [
  [2133, "Muğla'da orman yangını: Alevlere havadan ve karadan müdahale ediliyor"],
  [3079, "Antalya'da ormanlar alevlere teslim! Yangın ilçe sınırını aştı; üç mahalle tahliye edildi"],
  [2376, "Uşak'ta meşelik alanda çıkan yangına müdahale ediliyor"],
  [2751, "Bursa'da orman dışı alanda yangın"],
  [2852, "Çanakkale'de zirai alanda çıkan yangın kontrol altına alındı"],
  [3299, "Akdağ’da mera alanında yangın: Ekipler müdahale ediyor"],
  [2322, "Diyarbakır'da örtü yangını; ekiplerin müdahalesi sürüyor"],
  [2774, "Kaş'ta makilik alanda çıkan yangın söndürüldü"],
  [2474, "Munzur Vadisi Milli Parkı'ndaki orman yangını kontrol altına alındı"],
  [3139, "İstanbul'da otluk alanda çıkan yangın söndürüldü"],
  [2856, "Tarım arazisinde çıkan yangında 4 dönüm alan zarar gördü"],
  [2809, "Başkentte ağaçlık alanda çıkan yangın kontrol altına alındı"],
  // building/vehicle named, but the story is the wildfire
  [2578, "Bursa Karacabey’de orman yangını Fabrikaya ulaşmadan söndürüldü"],
  [2705, "Marmaris’te orman yangını! Çıkarma gemileri devreye girdi"],
  // signal only in the summary
  [3043, "Bursa'daki yangın kontrol altına alındı", "Bursa'nın Kestel ilçesinde orman dışı alanda çıkan yangın havadan ve karadan müdahaleyle kontrol altına alındı."],
];

const DROP: [number, string, string?][] = [
  [3767, "Bursa'da apartman dairesi alev alev yandı"],
  [3764, "E5'te otomobil alev topuna döndü"],
  [3765, "Kayseri'de fabrika yangını: 3 işçi dumandan etkilendi"],
  [3766, "Hafta sonu kış havası yaşanacak: Sıcaklıklar sert düşüyor, kar ve fırtına geliyor"],
  [3761, "Yeni Nostradamus 2028'i işaret etti, dünyayı bekleyen 3 felaketi açıkladı"],
  [2087, "İnegöl'de ev yangını: 1 ölü"],
  [2370, "Seyir halindeki otobüs alev aldı"],
  [3166, "Çorum'da apartmanda yangın; 2'si çocuk 7 kişi dumandan etkilendi"],
  [3444, "Metroda yangın paniği! Seferler aksadı"],
  [2414, "Meteoroloji uyardı: Marmara'da fırtına bekleniyor"],
  [2131, "Son dakika: İBB Genel Sekreter Yardımcısı Erdal Celal Aksoy tahliye edildi!"],
  // weak signal, but the title names a building or vehicle
  [2275, "Çatalca'da fabrika yangını", "Fabrikada çıkan yangın yandaki otluk alana sıçradı."],
  [3378, "Bursa'da tarlada bulunan baraka alevlere teslim oldu"],
  // "orman ürünleri" is a timber plant, not a forest
  [3685, "Bursa’da talaş silosu alevlere teslim oldu", "Bursa’nın İnegöl ilçesinde bir orman ürünleri fabrikasında çıkan yangın, itfaiye ekiplerince söndürüldü."],
  [1916, "Bursa'da fabrika bahçesinde çıkan yangın korkuttu", "Bursa'nın İnegöl ilçesinde faaliyet gösteren bir orman ürünleri fabrikasının bahçesinde çıkan yangın korkuttu."],
];

for (const [id, title, summary] of KEEP) {
  b(`keep #${id} ${title.slice(0, 50)}`, () => {
    const v = assessWildfire(title, `${title} ${summary ?? ''}`);
    assert.ok(v.wildfire, `dropped as ${v.basis}`);
  });
}
for (const [id, title, summary] of DROP) {
  b(`drop #${id} ${title.slice(0, 50)}`, () => {
    const v = assessWildfire(title, `${title} ${summary ?? ''}`);
    assert.ok(!v.wildfire, `kept on ${v.matched.join(',')}`);
  });
}

b('keywords match only at a word start (performans, kamera)', () => {
  assert.ok(!assessWildfire('Performans değerlendirmesinde yangın tatbikatı', '').wildfire);
  assert.ok(!assessWildfire('Kamera kayıtlarına göre yangın', '').wildfire);
  assert.ok(assessWildfire('(Orman) yangını', '').wildfire);
});
b('İ is folded: "ORMAN YANGINI" and "İzmir ormanlarında" match', () => {
  assert.ok(assessWildfire('ORMAN YANGINI', '').wildfire);
  assert.ok(assessWildfire('İzmir ormanlarında alevler', '').wildfire);
});
b('weak signal without any fire word is not enough', () => {
  const v = assessWildfire('Tarlada hasat başladı', 'Çiftçiler 100 dönüm arazide hasada başladı.');
  assert.strictEqual(v.wildfire, false);
  assert.strictEqual(v.basis, 'no_fire_word');
});
b('strong signal without any fire word is not enough (#3650, #3126)', () => {
  for (const t of [
    'Üniversiteyi ayağa kaldıran skandal olay! Genç kızı sürükleye sürükleye ormanlık alana götürdü',
    '93 yıl önce ormana dikilen ağaçlar felaketi yaşattı',
  ]) {
    const v = assessWildfire(t, t);
    assert.strictEqual(v.wildfire, false, t);
    assert.strictEqual(v.basis, 'no_fire_word');
  }
});
b('forest entry bans count as fire news (#2356)', () => {
  const t = 'Ormanlık alanlara giriş yasağına uymayan 513 kişiye ceza';
  assert.ok(assessWildfire(t, t).wildfire);
});

b('checkRelevance applies the gate after the whitelist and blocklist', () => {
  const src = readFileSync(join(__dirname, '../src/jobs/newsScraperJob.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function checkRelevance'), src.indexOf('function estimateReadMinutes'));
  assert.match(fn, /if \(!assessWildfire\(title, fullText\)\.wildfire\) return \{ relevant: false, reason: 'not_wildfire' \}/);
  assert.ok(fn.indexOf('BLOCKED_KEYWORDS') < fn.indexOf('assessWildfire'), 'gate must run after the blocklist');
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
