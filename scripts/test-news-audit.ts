import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RSS_SOURCES, REMOVED_NEWS_SOURCES, isRemovedDomain, NEWS_USER_AGENT } from '../src/config/newsSources';
import { parseAfad, parseGdelt, parseGdeltDate } from '../src/services/newsFetchers';
import { buildStories, placesIn, stageOf } from '../src/utils/newsStories';
import { provinceInTitle } from '../src/utils/newsGeography';
import { MIN_IMAGE_BYTES, pickFullest, thumbUrl } from '../src/services/newsThumbs';
import { toPublicNews } from '../src/utils/publicNews';

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

// AFAD
const afad = parseAfad(`<a class="x" href="//www.afad.gov.tr/orman-yangini-haberi"> <div class="card-img"><img/></div>
 <div class="card-body"><h6><span class="cardDate">04.11.2026</span></h6><h5 class="card-title">Orman yangını açıklaması</h5></div></a>`);
assert.equal(afad.length, 1);
assert.equal(afad[0].link, 'https://www.afad.gov.tr/orman-yangini-haberi');
assert.equal(afad[0].source, 'AFAD');
assert.equal(afad[0].publishedAt.toISOString().slice(0, 10), '2026-11-04');

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
  n(2, "Antalya Aksu'da yangın kontrol altına alındı", 9),
  n(3, "Antalya Kumluca'da orman yangını çıktı", 8),
  n(4, 'Antalya orman yangını haberi', 25),
  n(5, "Bursa'da tek haber", 7),
]);
assert.equal(stories.length, 1, 'different districts and a late item are separate fires; one item is no story');
assert.deepEqual(stories[0].items.map((i) => i.id), [1, 2]);
assert.deepEqual(stories[0].stages, ['started', 'controlled']);

// Thumbnails
assert.equal(pickFullest([Buffer.alloc(1052), null]), null, 'blank GIBS image is rejected');
const big = Buffer.alloc(MIN_IMAGE_BYTES + 5);
assert.equal(pickFullest([Buffer.alloc(MIN_IMAGE_BYTES), big]), big);
assert.match(thumbUrl(37, 28.5, '2026-10-05', 'L'), /BBOX=36.35%2C27.20%2C37.65%2C29.80/);

// Fact pool
const facts: any[] = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'public', 'nature', 'facts.json'), 'utf8'));
assert.ok(facts.length >= 120, `at least 120 facts, got ${facts.length}`);
assert.equal(new Set(facts.map((f) => f.tr)).size, facts.length, 'no Turkish text twice');
assert.equal(new Set(facts.map((f) => f.en)).size, facts.length, 'no English text twice');
assert.equal(new Set(facts.map((f) => f.id)).size, facts.length, 'no id twice');
for (const f of facts) {
  for (const k of ['tr', 'en', 'category', 'season', 'source_name', 'source_url']) assert.ok(String(f[k] ?? '').trim(), `${f.id} ${k}`);
  assert.match(f.source_url, /^https:\/\/[^/]+\/.+/, `${f.id} needs a specific page`);
  assert.ok(['all', 'spring', 'summer', 'autumn', 'winter'].includes(f.season), f.id);
}

console.log('news audit checks passed');
