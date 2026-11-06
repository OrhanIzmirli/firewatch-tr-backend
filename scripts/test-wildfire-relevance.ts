/**
 * Unit test for the wildfire gate on news (utils/wildfireRelevance.ts) and
 * its use on both sides: before an RSS item is stored and when /api/news
 * is read (utils/newsRelevance.ts, services/newsService.ts).
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
import { checkRelevance, isInFiresFeed, relevantPageIds } from '../src/utils/newsRelevance';

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
  assert.deepStrictEqual(checkRelevance("Muğla'da orman yangını", "Muğla'da orman yangını çıktı"), { relevant: true, reason: 'ok' });
  // passes the whitelist on "yangın", stopped by the wildfire gate
  assert.deepStrictEqual(checkRelevance("TEM'de otomobil yangını", "TEM'de otomobil yangını trafiği durdurdu"), { relevant: false, reason: 'not_wildfire' });
  // blocklist still wins over a wildfire word
  assert.strictEqual(checkRelevance('Orman yangını davası: mahkeme karar verdi', 'Orman yangını davası').reason, 'blocked');
});

// ---- read side: /api/news hides irrelevant stored rows without deleting them
const rows = [
  { id: 10, title: "Muğla'da orman yangını", summary: 'Havadan ve karadan müdahale ediliyor.' },
  { id: 9, title: "Bursa'da apartman dairesi alev alev yandı", summary: '' },
  { id: 8, title: "Kaş'ta makilik alanda çıkan yangın söndürüldü", summary: null },
  { id: 7, title: "İstanbul'a serin hava geliyor!", summary: 'Sıcaklıklar düşüyor, fırtına uyarısı.' },
  { id: 6, title: "Uşak'ta meşelik alanda çıkan yangına müdahale ediliyor", summary: '' },
];
b('isInFiresFeed keeps wildfire rows and drops the rest', () => {
  assert.deepStrictEqual(rows.filter(isInFiresFeed).map((r) => r.id), [10, 8, 6]);
});
b('pagination counts relevant rows only, in input order', () => {
  assert.deepStrictEqual(relevantPageIds(rows, 2, 0), [10, 8]);
  assert.deepStrictEqual(relevantPageIds(rows, 2, 2), [6]);
  assert.deepStrictEqual(relevantPageIds(rows, 2, 4), []);
});
b('newsService filters getAllNews and getNewsCount, and deletes nothing', () => {
  const src = readFileSync(join(__dirname, '../src/services/newsService.ts'), 'utf8');
  const all = src.slice(src.indexOf('async getAllNews'), src.indexOf('async getNewsById'));
  const count = src.slice(src.indexOf('async getNewsCount'));
  assert.match(all, /relevantPageIds\(candidates\.rows, limit, offset\)/);
  assert.ok(!/LIMIT \$|OFFSET \$/.test(all), 'SQL paging would count irrelevant rows');
  assert.match(count, /\.filter\(isInFiresFeed\)\.length/);
  assert.ok(!/DELETE/i.test(all + count));
});
b('scraper and clean-news use the same checkRelevance', () => {
  const job = readFileSync(join(__dirname, '../src/jobs/newsScraperJob.ts'), 'utf8');
  assert.match(job, /import \{ RelevanceResult, checkRelevance \} from '\.\.\/utils\/newsRelevance'/);
  assert.match(job, /export \{ checkRelevance \}/);
  assert.ok(!/const BLOCKED_KEYWORDS/.test(job), 'keyword lists must live only in utils/newsRelevance.ts');
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
