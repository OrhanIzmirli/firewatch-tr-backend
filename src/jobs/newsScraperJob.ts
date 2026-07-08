import cron from 'node-cron';
import axios from 'axios';
import * as xml2js from 'xml2js';
import newsService from '../services/newsService';

const CITY_REGION_MAP: Record<string, string> = {
  'izmir': 'Ege', 'muğla': 'Ege', 'aydın': 'Ege', 'denizli': 'Ege',
  'manisa': 'Ege', 'uşak': 'Ege', 'kütahya': 'Ege', 'afyon': 'Ege',
  'antalya': 'Akdeniz', 'mersin': 'Akdeniz', 'adana': 'Akdeniz',
  'hatay': 'Akdeniz', 'osmaniye': 'Akdeniz', 'kahramanmaraş': 'Akdeniz',
  'burdur': 'Akdeniz', 'isparta': 'Akdeniz',
  'istanbul': 'Marmara', 'bursa': 'Marmara', 'balıkesir': 'Marmara',
  'çanakkale': 'Marmara', 'tekirdağ': 'Marmara', 'edirne': 'Marmara',
  'kırklareli': 'Marmara', 'kocaeli': 'Marmara', 'sakarya': 'Marmara',
  'yalova': 'Marmara', 'bilecik': 'Marmara',
  'ankara': 'İç Anadolu', 'konya': 'İç Anadolu', 'eskişehir': 'İç Anadolu',
  'sivas': 'İç Anadolu', 'kayseri': 'İç Anadolu', 'aksaray': 'İç Anadolu',
  'niğde': 'İç Anadolu', 'nevşehir': 'İç Anadolu', 'kırıkkale': 'İç Anadolu',
  'trabzon': 'Karadeniz', 'samsun': 'Karadeniz', 'ordu': 'Karadeniz',
  'giresun': 'Karadeniz', 'rize': 'Karadeniz', 'artvin': 'Karadeniz',
  'zonguldak': 'Karadeniz', 'kastamonu': 'Karadeniz', 'sinop': 'Karadeniz',
  'bolu': 'Karadeniz', 'düzce': 'Karadeniz', 'bartın': 'Karadeniz',
  'erzurum': 'Doğu Anadolu', 'malatya': 'Doğu Anadolu', 'elazığ': 'Doğu Anadolu',
  'van': 'Doğu Anadolu', 'ağrı': 'Doğu Anadolu', 'kars': 'Doğu Anadolu',
  'iğdır': 'Doğu Anadolu', 'ardahan': 'Doğu Anadolu',
  'gaziantep': 'Güneydoğu Anadolu', 'şanlıurfa': 'Güneydoğu Anadolu',
  'diyarbakır': 'Güneydoğu Anadolu', 'mardin': 'Güneydoğu Anadolu',
  'batman': 'Güneydoğu Anadolu', 'siirt': 'Güneydoğu Anadolu',
  'şırnak': 'Güneydoğu Anadolu', 'adıyaman': 'Güneydoğu Anadolu',
  'kilis': 'Güneydoğu Anadolu',
};

// "Strong" fire/disaster signals — specific enough that they alone justify
// overriding the soft traffic-accident block below (see SOFT_TRAFFIC_KEYWORDS).
const STRONG_MUST_HAVE_KEYWORDS = [
  // 🔥 Yangın
  'yangın', 'yangin', 'yanıyor', 'yandı', 'tutuştu',
  'alevler', 'alev aldı', 'aleve boğuldu',
  'yangın çıktı', 'yangın söndür', 'yangın riski', 'yangın tehlikesi', 'yangın uyarısı',
  'orman yangını', 'orman yangini', 'makilik', 'ormanlık alan', 'duman',
  'tahliye edildi', 'tahliye emri', 'bina tahliye',
  // 🌡️ Sıcaklık & Kuraklık
  'kuraklık', 'kuraklik', 'kurak', 'sıcaklık rekoru', 'aşırı sıcak',
  'kavurucu sıcak', 'sıcak hava dalgası', 'yüksek sıcaklık', 'sıcaklık uyarısı',
  // 🌩️ Fırtına
  'fırtına', 'hortum', 'kasırga', 'şiddetli yağış', 'kuvvetli rüzgar',
  // 🌊 Su & Sel
  // NOTE: bare 'sel' was tested against live RSS data and dropped — it's a
  // substring of the extremely common Turkish "-sel" adjective suffix
  // (görsel/image-caption, bölgesel, evrensel, kişisel, hücresel...), so it
  // matched almost every article via routine photo-credit text. Compounds
  // only.
  'sel felaketi', 'sel baskını', 'seller bastı', 'ani sel', 'sele kapıldı',
  'taşkın', 'su baskını', 'dere taştı', 'tsunami',
  // ⛰️ Diğer Doğal Afetler
  'heyelan', 'toprak kayması', 'çığ', 'deprem', 'sarsıntı',
  'don olayı', 'dolu yağdı', 'dolu yağışı',
  // English (defensive — current RSS sources are Turkish-only, but future
  // English-language sources would need these to match)
  'wildfire', 'fire', 'forest fire', 'blaze', 'flood', 'drought', 'earthquake',
  'storm', 'hurricane', 'disaster', 'emergency', 'evacuation',
];

// "Weak" signals — organizational/contextual terms that respond to many
// incident types, not just fires (AFAD and itfaiye also handle traffic
// rescues, floods, building collapses, etc). Still count toward the overall
// must-have gate, but alone they don't override the traffic soft-block.
const WEAK_MUST_HAVE_KEYWORDS = [
  'itfaiye', 'afad', 'ogm', 'orman genel müdürlüğü', 'orman ekibi', 'söndürme ekibi',
  // NOTE: bare 'meteoroloji' and 'hava durumu' were tested against live RSS
  // and dropped — every routine daily weather forecast article uses these
  // words, so they matched constantly. The specific alert-level terms below
  // ('hava uyarısı', color codes) already cover genuine warnings.
  'hava uyarısı', 'sarı kod', 'turuncu kod', 'kırmızı kod',
  // NOTE: bare 'sağanak' (downpour) and 'dolu' (hail) were also tested and
  // dropped — routine daily forecasts mention downpours constantly without
  // being disaster-relevant. 'şiddetli yağış' (STRONG list) and 'dolu
  // yağdı'/'dolu yağışı' already cover the genuinely severe cases.
  'rüzgar uyarısı', 'nem oranı', 'nem düştü',
  'deniz kirliliği', 'deniz sıcaklığı', 'kıyı kirliliği',
  'hava kirliliği', 'çevre kirliliği', 'kirlilik uyarısı',
  'ekolojik felaket', 'çevre felaketi', 'doğa tahribatı', 'felaket', 'doğal afet',
  'iklim değişikliği', 'küresel ısınma', 'yüksek risk',
];

const MUST_HAVE_KEYWORDS = [...STRONG_MUST_HAVE_KEYWORDS, ...WEAK_MUST_HAVE_KEYWORDS];

// Traffic/accident terms only block when no STRONG fire/disaster keyword is
// also present — e.g. "otoyolda yangın nedeniyle trafik kilitlendi" should
// still pass, but a routine "trafik kazası" writeup that happens to mention
// "itfaiye ekipleri de sevk edildi" as boilerplate rescue-dispatch language
// should not.
const SOFT_TRAFFIC_KEYWORDS = [
  'trafik kazası', 'çarpıştı', 'devrildi', 'otobüs kazası', 'zincirleme',
  'trafik', 'kaza', 'kazada', 'çarpışma', 'otomobil', 'araç', 'direksiyon',
  'yaralı', 'yaralandı', 'hayatını kaybetti', 'yaşamını yitirdi', 'uçuruma',
  'çarpan', 'çarptı', 'hafif ticari', 'panelvan', 'lastik tamircisi',
  'boğuldu', 'yıldırım çarptı',
];

const BLOCKED_KEYWORDS = [
  // Şiddet/Suç
  'öldürüldü', 'öldürdü', 'cinayet', 'katil', 'ceset', 'infaz',
  'saldırı', 'bomba', 'terör', 'silahlı', 'silah', 'suç', 'hırsız',
  'mahkeme', 'dava', 'beraat', 'dolandırıcı', 'uyuşturucu', 'tutuklama', 'tutuklandı',
  'yargılanıyor', 'hapis cezası',
  // Spor
  'futbol', 'basketbol', 'voleybol', 'maç', 'gol', 'şampiyon', 'transfer', 'lig', 'forma', 'spor',
  // Eğlence/Magazin
  'dizi', 'film', 'müzik', 'şarkı', 'şarkıcı', 'konser', 'magazin', 'oyuncu',
  'ünlü', 'sosyete', 'defile', 'gündem olan paylaşım', 'sanatçı', 'güzellik', 'makyaj', 'kozmetik',
  // Ekonomi
  'borsa', 'dolar', 'euro', 'faiz', 'enflasyon', 'bütçe', 'vergi', 'ekonomi',
  'cryptocurrency', 'bitcoin', 'nft',
  // Siyaset
  // NOTE: bare 'bakan' was tested and dropped — it's also the present
  // participle of "bakmak" (to look after/attend to), e.g. "yangına bakan
  // itfaiyeci" (the firefighter attending to the fire), so it would have
  // blocked genuine fire coverage. 'bakanlık'/'bakanı' are specific to
  // "minister"/"ministry" and don't have that collision.
  'seçim', 'oy kullan', 'parti', 'milletvekili', 'meclis', 'cumhurbaşkanı', 'cumhurbaşkan',
  'muhalefet', 'iktidar', 'siyasi', 'hükümet', 'bakanlık', 'bakanı',
  // Askeri
  // NOTE: bare 'ordu' was tested and dropped — it's also the name of a
  // real Turkish province (Ordu, on the Black Sea coast), so it would
  // have blocked legitimate fire/flood news about that region.
  'mayın', 'denizaltı', 'fırkateyn', 'patlayıcı', 'silah sistemi',
  'savunma sanayii', 'mke', 'roket', 'hava savunma', 'nato', 'askeri', 'savaş', 'defense',
  'operasyon', 'gözaltı', 'fetö', 'pkk', 'iha düşürüldü', 'füze', 'nükleer',
  // Diplomatik / Uluslararası ilişkiler
  'ambassador', 'diplomat', 'summit', 'treaty', 'alliance', 'military',
  // Teknoloji
  'startup', 'yapay zeka', 'robot', 'fintek', 'yatırım', 'ihracat', 'ithalat',
  'teknoloji', 'akıllı telefon', 'yazılım şirketi', 'e-ticaret', 'telefon', 'bilgisayar', 'uzay',
  // Turizm/Seyahat
  'kruvaziyer', 'turist', 'tatil köyü', 'otel', 'schengen', 'vize',
  'turizm', 'uçuş', 'havayolu', 'pasaport', 'tatil',
  // Kişisel/Magazin
  'evlilik', 'boşanma', 'bebek', 'hamile', 'moda',
  'saç boyası', 'alerjik reaksiyon', 'otopsi', 'velayet', 'iletişim başkanı',
  // Uluslararası (Türkiye dışı)
  'kongo', 'ebola', 'japonya', 'venezuela', 'filistin', 'israil',
  'hindistan', 'pakistan', 'bangladeş', 'nepal',
  // Diğer
  'saç', 'dyson', 'bokashi', 'madalya', 'solotürk', 'fetih',
  'kadına yönelik', 'çocuk hakları', 'gezegen', 'petrol stok', 'zeytin satıcı', 'kurban hisse',
  'ta mektep', 'belediyesi çocuk', 'osmanlı', 'tarihi',
  'hakkını aradı', 'kovuldu', 'işten çıkarıldı', 'görevden alındı', 'istifa etti',
  // Dini/Bayram
  'kızılay', 'kurban', 'bayram', 'köfte', 'çorba', 'diyet', 'kanser', 'imece', 'zeytin', 'panik atak',
  'hatim', 'iftar', 'sahur', 'ramazan', 'kadir gecesi', 'mevlid', 'aşure',
  'hacı aday', 'hac ziyareti', 'hacı', 'umre', 'harem', 'medine', 'mekke', 'kabe',
  // Şehit/Asker cenazesi
  'şehit', 'cenaze', 'asker', 'jandarma', 'bakan yardımcısı', 'tören', 'tabut', 'gözyaşı',
  'şehitler', 'gaziler', 'gazi', 'askeri tören', 'askeri cenaze', 'asker uğurlama',
  'asker cenazesi', 'asker şehit', 'asker gazi', 'asker gazisi',
  'asker yaralı', 'asker yaralısı', 'asker yaralanma', 'asker yaralanması', 'asker yaralandı',
];

// region null = otomatik tespit, string = sabit bölge
const RSS_SOURCES: { url: string; source: string; region: string | null }[] = [
  // Ulusal
  { url: 'https://www.ntv.com.tr/gundem.rss', source: 'NTV', region: null },
  { url: 'https://www.ntv.com.tr/turkiye.rss', source: 'NTV Türkiye', region: null },
  { url: 'https://www.hurriyet.com.tr/rss/gundem', source: 'Hürriyet', region: null },
  { url: 'https://www.cnnturk.com/feed/rss/turkiye/news', source: 'CNN Türk', region: null },
  { url: 'https://www.sabah.com.tr/rss/gundem.xml', source: 'Sabah', region: null },
  { url: 'https://www.milliyet.com.tr/rss/rssNew/gundemRss.xml', source: 'Milliyet', region: null },
  { url: 'https://www.haberturk.com/rss/haber/gundem.xml', source: 'Haberturk', region: null },
  { url: 'https://www.trthaber.com/sondakika.rss', source: 'TRT Haber', region: null },
  { url: 'https://www.aa.com.tr/tr/rss/default?cat=guncel', source: 'AA', region: null },
  // Bölgesel
  { url: 'https://www.izmirhaber.com.tr/rss', source: 'İzmir Haber', region: 'Ege' },
  { url: 'https://www.bursahaber.com/rss', source: 'Bursa Haber', region: 'Marmara' },
];

function detectRegion(text: string): string {
  const lower = text.toLowerCase();
  for (const [city, region] of Object.entries(CITY_REGION_MAP)) {
    if (lower.includes(city)) return region;
  }
  return 'Türkiye Geneli';
}

function detectCategory(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('risk') || lower.includes('uyarı') || lower.includes('tehlike') ||
      lower.includes('kuraklık') || lower.includes('sıcaklık') || lower.includes('meteoroloji') ||
      lower.includes('deprem') || lower.includes('tsunami')) {
    return 'Risk';
  }
  if (lower.includes('söndürme') || lower.includes('müdahale') ||
      lower.includes('itfaiye') || lower.includes('kurtarma') || lower.includes('tahliye')) {
    return 'Operasyon';
  }
  if (lower.includes('güvenlik') || lower.includes('önlem') ||
      lower.includes('yasak') || lower.includes('uyarı')) {
    return 'Güvenlik';
  }
  return 'Güncelleme';
}

type RelevanceResult = {
  relevant: boolean;
  reason: 'no_must_have' | 'blocked' | 'traffic_noise' | 'ok';
};

// Two-layer filter: Layer 1 blocks off-topic content outright (politics,
// sports, military, entertainment, etc); Layer 2 requires at least one
// genuine fire/disaster signal. Traffic/casualty wording is a special case
// (SOFT_TRAFFIC_KEYWORDS) — it only blocks when no STRONG fire keyword is
// also present, so "otomobil yandı" (car caught fire) still passes but a
// routine crash writeup that mentions "itfaiye" only as boilerplate
// rescue-dispatch language does not.
function checkRelevance(text: string): RelevanceResult {
  const lower = text.toLowerCase().trim();

  const hasMustHave = MUST_HAVE_KEYWORDS.some(kw => lower.includes(kw));
  if (!hasMustHave) return { relevant: false, reason: 'no_must_have' };

  if (BLOCKED_KEYWORDS.some(kw => lower.includes(kw))) {
    return { relevant: false, reason: 'blocked' };
  }

  const hasStrongFire = STRONG_MUST_HAVE_KEYWORDS.some(kw => lower.includes(kw));
  const hasTrafficNoise = SOFT_TRAFFIC_KEYWORDS.some(kw => lower.includes(kw));
  if (hasTrafficNoise && !hasStrongFire) {
    return { relevant: false, reason: 'traffic_noise' };
  }

  return { relevant: true, reason: 'ok' };
}

function isRelevant(text: string): boolean {
  return checkRelevance(text).relevant;
}

function estimateReadMinutes(text: string): number {
  const wordCount = text.split(' ').length;
  return Math.max(1, Math.ceil(wordCount / 200));
}

async function fetchRSS(url: string): Promise<any[]> {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'FireWatch TR News Bot 1.0' },
    });
    const parsed = await xml2js.parseStringPromise(response.data, {
      explicitArray: false,
    });
    const items = parsed?.rss?.channel?.item || [];
    return Array.isArray(items) ? items : [items];
  } catch (error) {
    console.error(`RSS fetch error for ${url}:`, error);
    return [];
  }
}

class NewsScraperJob {
  start() {
    console.log('🔥 News Scraper Job starting...');
    cron.schedule('0 */6 * * *', async () => {
      await this.runScraper();
    });
    this.runScraper();
  }

  async runScraper() {
    console.log('🔍 Running news scraper at:', new Date().toISOString());
    let totalAdded = 0;
    let totalFetched = 0;
    const filterCounts: Record<RelevanceResult['reason'], number> = {
      no_must_have: 0,
      blocked: 0,
      traffic_noise: 0,
      ok: 0,
    };

    for (const source of RSS_SOURCES) {
      try {
        const items = await fetchRSS(source.url);
        console.log(`📰 ${source.source}: ${items.length} items found`);
        totalFetched += items.length;

        for (const item of items) {
          const title = item.title || '';
          const summary = item.description || '';
          const link = item.link || '';
          const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
          const fullText = `${title} ${summary}`;

          const relevance = checkRelevance(fullText);
          filterCounts[relevance.reason]++;
          if (!relevance.relevant) continue;

          // Bölgesel kaynak ise sabit region, yoksa otomatik tespit
          const region = source.region ?? detectRegion(fullText);
          const category = detectCategory(fullText);
          const readMinutes = estimateReadMinutes(summary);
          const isBreaking = fullText.toLowerCase().includes('son dakika');
          const cleanSummary = summary.replace(/<[^>]*>/g, '').trim();

          try {
            const created = await newsService.createNews({
              title: title.trim(),
              summary: cleanSummary,
              body: cleanSummary,
              source: source.source,
              source_url: link,
              source_id: link,
              category,
              is_breaking: isBreaking,
              published_at: pubDate,
              read_minutes: readMinutes,
              related_region: region,
              highlights: [],
              paragraphs: [],
            });

            if (created) {
              totalAdded++;
              console.log(`✅ Added: [${region}] ${title.substring(0, 50)}`);
            } else {
              console.log(`⏭️ Duplicate: ${title.substring(0, 40)}`);
            }
          } catch (err: any) {
            console.error(`❌ DB error:`, err.message);
          }
        }
      } catch (error) {
        console.error(`❌ Error processing ${source.source}:`, error);
      }
    }

    console.log(
      `✅ Scraper done. Fetched: ${totalFetched} | Passed both layers: ${filterCounts.ok} | Added (new): ${totalAdded}`
    );
    console.log(
      `   Filter breakdown — no must-have keyword: ${filterCounts.no_must_have}, ` +
      `blocked (Layer 1): ${filterCounts.blocked}, traffic noise: ${filterCounts.traffic_noise}, passed: ${filterCounts.ok}`
    );
  }
}

export default new NewsScraperJob();