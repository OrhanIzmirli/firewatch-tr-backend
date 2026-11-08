import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { OFFICIAL_SOURCES, RSS_SOURCES, REMOVED_NEWS_SOURCES, isRemovedDomain, NEWS_USER_AGENT } from '../src/config/newsSources';
import { parseCards, parseGdelt, parseGdeltDate, parseOgm } from '../src/services/newsFetchers';
import { buildStories, placesIn, stageOf } from '../src/utils/newsStories';
import { provinceInTitle } from '../src/utils/newsGeography';
import { MIN_IMAGE_BYTES, pickFullest, thumbUrl } from '../src/services/newsThumbs';
import { headlineProvince, toPublicNews } from '../src/utils/publicNews';
import { isGreenStory, newsKind } from '../src/utils/newsKinds';

// Sources
for (const removed of REMOVED_NEWS_SOURCES) assert.ok(!RSS_SOURCES.some((s) => s.source === removed), removed);
assert.ok(!/Mozilla|Chrome/.test(NEWS_USER_AGENT), 'never pose as a browser');
for (const d of ['www.hurriyet.com.tr', 'aa.com.tr', 'video.sozcu.com.tr']) assert.ok(isRemovedDomain(d), d);
assert.ok(!isRemovedDomain('bursahaber.com'));
assert.ok(!isRemovedDomain('notaa.com.tr'));

// GDELT
assert.equal(parseGdeltDate('20261108T123000Z')?.toISOString(), '2026-11-08T12:30:00.000Z');
assert.equal(parseGdeltDate('dün'), null);
const gdelt = parseGdelt({
  articles: [
    { title: ' Muğla\'da orman yangını ', url: 'https://yerel.example/a', domain: 'www.yerel.example', seendate: '20261108T123000Z' },
    { title: 'Aynı haber', url: 'https://www.hurriyet.com.tr/a', domain: 'hurriyet.com.tr', seendate: '20261108T123000Z' },
    { title: 'Tarihsiz', url: 'https://x.example/a', domain: 'x.example', seendate: '' },
  ],
});
assert.equal(gdelt.length, 1);
assert.equal(gdelt[0].source, 'yerel.example');
assert.equal(gdelt[0].title, "Muğla'da orman yangını");
assert.deepEqual(parseGdelt(null), []);

// Official pages
const afad = parseCards(`<a class="x" href="//www.afad.gov.tr/orman-yangini-haberi"> <div class="card-img"><img/></div>
 <div class="card-body"><h6><span class="cardDate">04.11.2026</span></h6><h5 class="card-title">Orman yangını açıklaması</h5></div></a>`, 'AFAD', 'https://www.afad.gov.tr/haberler');
assert.equal(afad.length, 1);
assert.equal(afad[0].link, 'https://www.afad.gov.tr/orman-yangini-haberi');
assert.equal(afad[0].source, 'AFAD');
assert.equal(afad[0].publishedAt.toISOString().slice(0, 10), '2026-11-04');
const ogm = parseOgm('items:[{Title: "Fidan \\"dikimi\\"",Description: "",Link: "/antalyaobm/haberler/x",Image: "/a.jpg",SourceTitle: "",Date: new Date("2026-10-30T00:00:00Z")}]', 'OGM Antalya', 'https://www.ogm.gov.tr/antalyaobm/haberler');
assert.equal(ogm[0].title, 'Fidan "dikimi"');
assert.equal(ogm[0].link, 'https://www.ogm.gov.tr/antalyaobm/haberler/x');
assert.equal(ogm[0].publishedAt.toISOString().slice(0, 10), '2026-10-30');
for (const s of OFFICIAL_SOURCES) assert.ok(!/tarimorman/.test(s.url), 'robots.txt closes the ministry');
assert.ok(RSS_SOURCES.length >= 30);

// Only headline, source and link leave the API.
const pub = toPublicNews({
  id: 1, title: "Bodrum'da yangın, Muğla", summary: 'kopya', body: 'kopya', source: 'Bursa Haber', source_url: 'https://u',
  highlights: ['k'], paragraphs: ['k'], image_url: 'https://i', thumbnail_url: 'https://t', is_breaking: false,
  published_at: new Date('2026-10-05T10:00:00Z'), created_at: new Date('2026-10-05T10:00:00Z'),
});
assert.equal(pub.summary, '');
assert.equal(pub.body, '');
assert.deepEqual(pub.highlights, []);
assert.deepEqual(pub.paragraphs, []);
assert.equal((pub as any).image_url, undefined);
assert.equal((pub as any).thumbnail_url, undefined);
assert.equal(pub.province, 'Muğla');
assert.match(pub.thumb_path ?? '', /^\/api\/news\/thumb\/Mu%C4%9Fla\/2026-10-05$/);

// Stories
assert.equal(stageOf("Bodrum'da çıkan orman yangını kontrol altına alındı"), 'controlled');
assert.equal(stageOf('Konya\'da çıkan orman yangını söndürüldü'), 'out');
assert.equal(stageOf('Yanan alanda ağaçlandırma başladı'), 'restoration');
assert.equal(stageOf('Sonbahar geldi'), null);
assert.equal(provinceInTitle("Antalya'da orman yangını"), 'Antalya');
assert.equal(provinceInTitle('Sonbahar geldi'), null);
assert.deepEqual([...placesIn("Antalya'nın Kumluca'daki yangın", 'Antalya')], ['kumluca']);

const at = (d: number) => new Date(Date.UTC(2026, 8, d, 10));
const n = (id: number, title: string, d: number) => ({ id, title, source: 'x', source_url: 'u', published_at: at(d) });
const stories = buildStories([
  n(1, "Antalya Aksu'da orman yangını çıktı", 7),
  n(2, "Antalya Aksu'da orman yangını kontrol altına alındı", 8),
  n(3, "Antalya Kumluca'da orman yangını çıktı", 8),
  n(4, 'Antalya orman yangını haberi', 25),
  n(5, "Bursa'da tek haber yangın", 7),
]);
assert.equal(stories.length, 1, 'different districts and a late item are separate fires; one item is no story');
assert.deepEqual(stories[0].items.map((i) => i.id), [1, 2]);
assert.deepEqual(stories[0].stages, ['started', 'controlled']);

assert.equal(provinceInTitle("Kumluca'daki orman yangınına Bursa'dan destek"), null, 'help from Bursa is not a fire in Bursa');
assert.equal(provinceInTitle("Adana, Antalya ve Mersin'de orman yangınları"), null, 'several provinces have no single picture');
const kumluca = { id: 1, name: 'Kumluca', provinceId: 7, provinceName: 'Antalya', lat: 0, lng: 0 };
assert.equal(headlineProvince("Kumluca'daki orman yangınına Bursa'dan destek", [kumluca]), 'Antalya', 'a district names its province');
assert.equal(toPublicNews({ id: 2, title: "Kumluca'da orman yangını", body: '', is_breaking: false, created_at: new Date('2026-09-08') } as any, [kumluca]).province, 'Antalya');

// The bug the owner saw: stubble and farm fires never join a forest-fire story.
const noField = buildStories([
  n(1, "Bursa'da orman yangını çıktı", 7),
  n(2, "Bursa'da anız yangını çıktı", 7),
  n(3, "Bursa'da tarla yangını söndürüldü", 8),
  n(4, "Bursa'da orman yangını söndürüldü", 8),
]);
assert.equal(noField.length, 2);
for (const g of noField) {
  const forest = g.items.some((i) => /orman/.test(i.title));
  const field = g.items.some((i) => /anız|tarla/.test(i.title));
  assert.ok(!(forest && field), 'one story, one kind of fire');
}
const far = buildStories([n(1, "Bursa'da orman yangını çıktı", 1), n(2, "Bursa'da orman yangını sürüyor", 3), n(3, "Bursa'da orman yangını söndürüldü", 5), n(4, "Bursa'da orman yangını çıktı", 7), n(5, "Bursa'da orman yangını sürüyor", 9), n(6, "Bursa'da orman yangını çıktı", 11)]);
for (const g of far) assert.ok(g.items[g.count - 1].published_at.getTime() - g.items[0].published_at.getTime() <= 8 * 86_400_000, 'a story spans one event');
const vague = buildStories([n(1, "Bursa'da orman yangını çıktı", 1), n(2, "Bursa'da korkutan olay yangın", 3)]);
assert.equal(vague.length, 0, 'a vague headline two days later is not the same fire');

// Kinds keep winter news useful
assert.equal(newsKind('Yanan alanlara 50 bin fidan dikildi'), 'recovery');
assert.equal(newsKind('Orman yangınlarına karşı tatbikat yapıldı'), 'preparation');
assert.equal(newsKind('Milli parkta yaban keçileri görüntülendi'), 'nature');
assert.equal(newsKind("Bursa'da anız yangını"), 'field');
assert.equal(newsKind("Muğla'da orman yangını"), 'fire');
assert.equal(newsKind('Ekonomi haberi'), null);
assert.ok(isGreenStory('Yanan alanlara 50 bin fidan dikildi'));
assert.ok(!isGreenStory("Muğla'da orman yangını"));
assert.ok(!isGreenStory('Kanada milli parkında yaban hayatı'), 'abroad stays out');
assert.ok(!isGreenStory('Ormancılara Jandarmadan trafik güvenliği eğitimi.'), 'forester alone is not a topic');
assert.ok(!isGreenStory('Ormancılar futbol turnuvasında buluştu'), 'forester alone is not a topic');
assert.ok(!isGreenStory('Ormancılık Haftası kutlandı'), 'forestry alone is not a topic');
assert.strictEqual(newsKind('Ormancılara Jandarmadan trafik güvenliği eğitimi.'), null);
assert.ok(isGreenStory('Ormancılar Bolu’da fidan üretimini anlattı'), 'forester with a topic stays');
assert.ok(isGreenStory('Ormancılık çalışmalarıyla bozuk orman restorasyonu Muğla’da sürüyor'), 'forestry with a topic stays');
assert.strictEqual(newsKind('Ormancılar orman yangınına müdahale etti'), 'fire');
assert.equal(newsKind("Nefes darlığının kısır döngüsünü 'Pulmoner Rehabilitasyon' ile kırın"), null, 'medical rehabilitation is not forest news');

// Thumbnails
assert.equal(pickFullest([Buffer.alloc(1052), null]), null, 'blank GIBS image is rejected');
const big = Buffer.alloc(MIN_IMAGE_BYTES + 5);
assert.equal(pickFullest([Buffer.alloc(MIN_IMAGE_BYTES), big]), big);
assert.match(thumbUrl(37, 28.5, '2026-10-05', 'L'), /BBOX=36.35%2C27.20%2C37.65%2C29.80/);

// Fact pool
const facts: any[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'nature', 'facts.json'), 'utf8'));
assert.ok(facts.length >= 365, `at least 365 facts, got ${facts.length}`);
assert.ok(facts.filter((f) => f.category === 'satellites').length / facts.length <= 0.15, 'satellite facts stay at most 15%');
assert.equal(new Set(facts.map((f) => f.tr)).size, facts.length, 'no Turkish text twice');
assert.equal(new Set(facts.map((f) => f.en)).size, facts.length, 'no English text twice');
assert.equal(new Set(facts.map((f) => f.id)).size, facts.length, 'no id twice');
for (const f of facts) {
  for (const k of ['tr', 'en', 'category', 'season', 'source_name', 'source_url']) assert.ok(String(f[k] ?? '').trim(), `${f.id} ${k}`);
  assert.match(f.source_url, /^https:\/\/[^/]+\/.+/, `${f.id} needs a specific page`);
  assert.ok(['all', 'spring', 'summer', 'autumn', 'winter'].includes(f.season), f.id);
}

console.log('news audit checks passed');
