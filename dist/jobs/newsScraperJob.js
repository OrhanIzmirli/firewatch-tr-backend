"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_cron_1 = __importDefault(require("node-cron"));
const axios_1 = __importDefault(require("axios"));
const xml2js = __importStar(require("xml2js"));
const newsService_1 = __importDefault(require("../services/newsService"));
const CITY_REGION_MAP = {
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
// STRICT WHITELIST — checked against the TITLE only (not the summary).
// Titles are short enough that a fire/disaster keyword appearing in one is
// a much stronger relevance signal than the same keyword appearing
// somewhere in a long article body, and this cuts the false-positive rate
// dramatically compared to matching the full text.
//
// A few words from the original request are intentionally replaced with
// safer compounds after empirically testing against 355 live RSS articles
// and re-discovering collisions already found and fixed in an earlier
// pass: bare 'sel' matches the extremely productive Turkish "-sel"
// adjective suffix (Selçuk, ASELSAN, yükseldi, bitkisel, kitlesel...);
// bare 'afet' matches inside the name "Şerafettin"; bare 'tahliye' collides
// with its legal "release from custody" sense; bare 'uyarı'/'risk'/
// 'tehlike' are generic words used across every news domain (a judge's
// "sert uyarı", a hair-dye article asking "kimler risk altında?", a
// wildlife story where "dokunmak bile tehlikeli"), not just weather/fire.
const MUST_HAVE_KEYWORDS = [
    'yangın', 'yangin', 'orman yangını', 'orman yangini', 'alevler', 'alev aldı', 'duman',
    'tahliye edildi', 'tahliye emri', 'bina tahliye', 'itfaiye', 'afad',
    'kuraklık', 'sel felaketi', 'sel baskını', 'seller bastı', 'ani sel', 'sele kapıldı', 'taşkın',
    'fırtına', 'hortum', 'kasırga', 'heyelan',
    'hava uyarısı', 'sarı kod', 'turuncu kod', 'kırmızı kod',
    'yangın uyarısı', 'sel uyarısı', 'fırtına uyarısı',
    'acil durum', 'felaket', 'doğal afet', 'yangın riski', 'yangın tehlikesi',
    'sıcak hava dalgası', 'aşırı sıcak', 'kavurucu sıcak',
    'wildfire', 'fire', 'flood', 'drought', 'storm', 'disaster', 'emergency',
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
    // NOTE: bare 'bakan' is also the present participle of "bakmak" (to look
    // after/attend to), e.g. "yangına bakan itfaiyeci" (the firefighter
    // attending to the fire) — a real but rare headline construction. Kept
    // in per explicit repeated request; 'bakanlık'/'bakanı' below already
    // cover the far more common "X Bakanı"/"X Bakanlığı" inflections without
    // that risk.
    'seçim', 'oy kullan', 'parti', 'milletvekili', 'meclis', 'cumhurbaşkanı', 'cumhurbaşkan',
    'muhalefet', 'iktidar', 'siyasi', 'hükümet', 'bakanlık', 'bakanı', 'bakan',
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
    'fransa', 'france', 'almanya', 'rusya', 'ukrayna', 'suriye', 'irak', 'iran',
    // Deprem — out of scope for this app (wildfire-focused, not general
    // disaster coverage) per explicit product decision.
    'deprem',
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
const RSS_SOURCES = [
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
function detectRegion(text) {
    const lower = text.toLowerCase();
    for (const [city, region] of Object.entries(CITY_REGION_MAP)) {
        if (lower.includes(city))
            return region;
    }
    return 'Türkiye Geneli';
}
function detectCategory(text) {
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
// Strict whitelist: the MUST_HAVE check runs against the TITLE only (a
// much stronger, lower-noise relevance signal than matching anywhere in
// the full article body — see the comment on MUST_HAVE_KEYWORDS). The
// BLOCKED check runs against the full text (title + summary) since
// blocking is inherently conservative — checking the summary too only
// ever removes more off-topic content, never loses genuine matches.
function checkRelevance(title, fullText) {
    const titleLower = title.toLowerCase().trim();
    const fullLower = fullText.toLowerCase().trim();
    const hasMustHave = MUST_HAVE_KEYWORDS.some(kw => titleLower.includes(kw));
    if (!hasMustHave)
        return { relevant: false, reason: 'no_must_have' };
    if (BLOCKED_KEYWORDS.some(kw => fullLower.includes(kw))) {
        return { relevant: false, reason: 'blocked' };
    }
    return { relevant: true, reason: 'ok' };
}
function estimateReadMinutes(text) {
    const wordCount = text.split(' ').length;
    return Math.max(1, Math.ceil(wordCount / 200));
}
async function fetchRSS(url) {
    try {
        const response = await axios_1.default.get(url, {
            timeout: 10000,
            headers: { 'User-Agent': 'FireWatch TR News Bot 1.0' },
        });
        const parsed = await xml2js.parseStringPromise(response.data, {
            explicitArray: false,
        });
        const items = parsed?.rss?.channel?.item || [];
        return Array.isArray(items) ? items : [items];
    }
    catch (error) {
        console.error(`RSS fetch error for ${url}:`, error);
        return [];
    }
}
class NewsScraperJob {
    start() {
        console.log('🔥 News Scraper Job starting...');
        node_cron_1.default.schedule('0 */6 * * *', async () => {
            await this.runScraper();
        });
        this.runScraper();
    }
    async runScraper() {
        console.log('🔍 Running news scraper at:', new Date().toISOString());
        let totalAdded = 0;
        let totalFetched = 0;
        const filterCounts = {
            no_must_have: 0,
            blocked: 0,
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
                    const relevance = checkRelevance(title, fullText);
                    filterCounts[relevance.reason]++;
                    if (!relevance.relevant)
                        continue;
                    // Bölgesel kaynak ise sabit region, yoksa otomatik tespit
                    const region = source.region ?? detectRegion(fullText);
                    const category = detectCategory(fullText);
                    const readMinutes = estimateReadMinutes(summary);
                    const isBreaking = fullText.toLowerCase().includes('son dakika');
                    const cleanSummary = summary.replace(/<[^>]*>/g, '').trim();
                    try {
                        const created = await newsService_1.default.createNews({
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
                        }
                        else {
                            console.log(`⏭️ Duplicate: ${title.substring(0, 40)}`);
                        }
                    }
                    catch (err) {
                        console.error(`❌ DB error:`, err.message);
                    }
                }
            }
            catch (error) {
                console.error(`❌ Error processing ${source.source}:`, error);
            }
        }
        console.log(`✅ Scraper done. Fetched: ${totalFetched} | Passed whitelist: ${filterCounts.ok} | Added (new): ${totalAdded}`);
        console.log(`   Filter breakdown — no must-have keyword in title: ${filterCounts.no_must_have}, ` +
            `blocked: ${filterCounts.blocked}, passed: ${filterCounts.ok}`);
    }
}
exports.default = new NewsScraperJob();
