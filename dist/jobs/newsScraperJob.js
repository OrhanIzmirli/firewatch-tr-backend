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
const MUST_HAVE_KEYWORDS = [
    // 🔥 Yangın (öncelikli)
    'yangın', 'yanıyor', 'yandı', 'alevler', 'alev aldı', 'tutuştu',
    'yangın çıktı', 'yangın söndür', 'yangın riski', 'yangın tehlikesi',
    'orman yangını', 'orman ekibi', 'söndürme ekibi', 'itfaiye',
    'afad', 'ogm', 'orman genel müdürlüğü', 'makilik', 'ormanlık alan',
    // 🌡️ Sıcaklık & Kuraklık
    'kuraklık', 'kurak', 'sıcaklık rekoru', 'aşırı sıcak',
    'kavurucu sıcak', 'sıcak hava dalgası', 'yüksek sıcaklık',
    'sıcaklık uyarısı', 'nem oranı', 'nem düştü',
    // 🌩️ Hava Durumu & Fırtına
    'meteoroloji', 'hava durumu', 'hava uyarısı',
    'sarı kod', 'turuncu kod', 'kırmızı kod',
    'fırtına', 'şiddetli yağış', 'sağanak', 'dolu',
    'rüzgar uyarısı', 'kuvvetli rüzgar',
    // 🌊 Su & Deniz
    'sel', 'taşkın', 'su baskını', 'dere taştı',
    'deniz kirliliği', 'deniz sıcaklığı', 'kıyı kirliliği',
    // 🌿 Çevre & Kirlilik
    'hava kirliliği', 'çevre kirliliği', 'kirlilik uyarısı',
    'ekolojik felaket', 'çevre felaketi', 'doğa tahribatı',
    'iklim değişikliği', 'küresel ısınma',
    // ⛰️ Diğer Doğal Afetler
    'heyelan', 'toprak kayması', 'çığ', 'deprem',
];
const BLOCKED_KEYWORDS = [
    // Şiddet/Suç
    'öldürüldü', 'öldürdü', 'cinayet', 'katil', 'ceset', 'infaz',
    'saldırı', 'bomba', 'terör', 'silahlı',
    // Trafik
    'trafik kazası', 'çarpıştı', 'devrildi', 'otobüs kazası', 'zincirleme',
    // Spor
    'futbol', 'basketbol', 'maç', 'gol', 'şampiyon', 'transfer', 'lig', 'forma',
    // Eğlence
    'dizi', 'film', 'müzik', 'şarkı', 'konser', 'magazin', 'oyuncu',
    // Ekonomi
    'borsa', 'dolar', 'euro', 'faiz', 'enflasyon', 'bütçe', 'vergi',
    // Siyaset
    'seçim', 'parti', 'milletvekili', 'meclis', 'cumhurbaşkanı', 'muhalefet',
    // Diğer
    'evlilik', 'boşanma', 'bebek', 'hamile', 'moda', 'tatil', 'operasyon', 'gözaltı', 'fetö', 'pkk', 'mit', 'emniyet operasyon',
    'iha', 'drone', 'füze', 'nükleer',
    'saç', 'alerjik', 'otopsi', 'velayet', 'sosyal medya paylaş',
    'iletişim başkanı', 'altun', 'mayın', 'denizaltı', 'fırkateyn', 'patlayıcı', 'silah sistemi',
    'savunma sanayii', 'mke', 'roket', 'hava savunma',
];
const RSS_SOURCES = [
    { url: 'https://www.ntv.com.tr/gundem.rss', source: 'NTV' },
    { url: 'https://www.ntv.com.tr/turkiye.rss', source: 'NTV Türkiye' },
    { url: 'https://www.hurriyet.com.tr/rss/gundem', source: 'Hürriyet' },
    { url: 'https://www.cnnturk.com/feed/rss/turkiye/news', source: 'CNN Türk' },
    { url: 'https://www.sabah.com.tr/rss/gundem.xml', source: 'Sabah' },
    { url: 'https://www.milliyet.com.tr/rss/rssNew/gundemRss.xml', source: 'Milliyet' },
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
        lower.includes('operasyon') || lower.includes('itfaiye') ||
        lower.includes('kurtarma') || lower.includes('tahliye')) {
        return 'Operasyon';
    }
    if (lower.includes('güvenlik') || lower.includes('önlem') ||
        lower.includes('yasak') || lower.includes('uyarı')) {
        return 'Güvenlik';
    }
    return 'Güncelleme';
}
function isRelevant(text) {
    const lower = text.toLowerCase();
    if (BLOCKED_KEYWORDS.some(kw => lower.includes(kw)))
        return false;
    return MUST_HAVE_KEYWORDS.some(kw => lower.includes(kw));
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
        for (const source of RSS_SOURCES) {
            try {
                const items = await fetchRSS(source.url);
                console.log(`📰 ${source.source}: ${items.length} items found`);
                for (const item of items) {
                    const title = item.title || '';
                    const summary = item.description || '';
                    const link = item.link || '';
                    const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
                    const fullText = `${title} ${summary}`;
                    if (!isRelevant(fullText))
                        continue;
                    const region = detectRegion(fullText);
                    const category = detectCategory(fullText);
                    const readMinutes = estimateReadMinutes(summary);
                    const isBreaking = fullText.toLowerCase().includes('son dakika');
                    const cleanSummary = summary.replace(/<[^>]*>/g, '').trim();
                    try {
                        await newsService_1.default.createNews({
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
                        totalAdded++;
                        console.log(`✅ Added: ${title.substring(0, 60)}`);
                    }
                    catch (err) {
                        if (err.code === '23505') {
                            console.log(`⏭️ Duplicate: ${title.substring(0, 40)}`);
                        }
                        else {
                            console.error(`❌ DB error:`, err.message);
                        }
                    }
                }
            }
            catch (error) {
                console.error(`❌ Error processing ${source.source}:`, error);
            }
        }
        console.log(`✅ Scraper done. Total added: ${totalAdded}`);
    }
}
exports.default = new NewsScraperJob();
