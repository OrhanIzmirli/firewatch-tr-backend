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
// Bölge tespiti için şehir → bölge mapping
const CITY_REGION_MAP = {
    // Ege
    'izmir': 'Ege', 'muğla': 'Ege', 'aydın': 'Ege', 'denizli': 'Ege',
    'manisa': 'Ege', 'uşak': 'Ege', 'kütahya': 'Ege', 'afyon': 'Ege',
    // Akdeniz
    'antalya': 'Akdeniz', 'mersin': 'Akdeniz', 'adana': 'Akdeniz',
    'hatay': 'Akdeniz', 'osmaniye': 'Akdeniz', 'kahramanmaraş': 'Akdeniz',
    'burdur': 'Akdeniz', 'isparta': 'Akdeniz',
    // Marmara
    'istanbul': 'Marmara', 'bursa': 'Marmara', 'balıkesir': 'Marmara',
    'çanakkale': 'Marmara', 'tekirdağ': 'Marmara', 'edirne': 'Marmara',
    'kırklareli': 'Marmara', 'kocaeli': 'Marmara', 'sakarya': 'Marmara',
    'yalova': 'Marmara', 'bilecik': 'Marmara',
    // İç Anadolu
    'ankara': 'İç Anadolu', 'konya': 'İç Anadolu', 'eskişehir': 'İç Anadolu',
    'sivas': 'İç Anadolu', 'kayseri': 'İç Anadolu', 'aksaray': 'İç Anadolu',
    'niğde': 'İç Anadolu', 'nevşehir': 'İç Anadolu', 'kırıkkale': 'İç Anadolu',
    // Karadeniz
    'trabzon': 'Karadeniz', 'samsun': 'Karadeniz', 'ordu': 'Karadeniz',
    'giresun': 'Karadeniz', 'rize': 'Karadeniz', 'artvin': 'Karadeniz',
    'zonguldak': 'Karadeniz', 'kastamonu': 'Karadeniz', 'sinop': 'Karadeniz',
    'bolu': 'Karadeniz', 'düzce': 'Karadeniz', 'bartın': 'Karadeniz',
    // Doğu Anadolu
    'erzurum': 'Doğu Anadolu', 'malatya': 'Doğu Anadolu', 'elazığ': 'Doğu Anadolu',
    'van': 'Doğu Anadolu', 'ağrı': 'Doğu Anadolu', 'kars': 'Doğu Anadolu',
    'iğdır': 'Doğu Anadolu', 'ardahan': 'Doğu Anadolu',
    // Güneydoğu Anadolu
    'gaziantep': 'Güneydoğu Anadolu', 'şanlıurfa': 'Güneydoğu Anadolu',
    'diyarbakır': 'Güneydoğu Anadolu', 'mardin': 'Güneydoğu Anadolu',
    'batman': 'Güneydoğu Anadolu', 'siirt': 'Güneydoğu Anadolu',
    'şırnak': 'Güneydoğu Anadolu', 'adıyaman': 'Güneydoğu Anadolu',
    'kilis': 'Güneydoğu Anadolu',
};
// Yangın ile ilgili keywordler
const FIRE_KEYWORDS = [
    'yangın', 'orman yangını', 'yangınlar', 'yanıyor', 'yandı',
    'söndürme', 'itfaiye', 'afad', 'ogm', 'tahliye',
    'alevler', 'ateş', 'yanmaya başladı', 'yangın çıktı',
    'yangın riski', 'kuraklık', 'meteoroloji uyarı',
];
// Engellenecek keywordler
const BLOCKED_KEYWORDS = [
    'cinayet', 'ölüm', 'öldürüldü', 'kaza', 'trafik',
    'futbol', 'maç', 'gol', 'şampiyon', 'transfer',
    'magazin', 'dizi', 'film', 'müzik', 'şarkı',
    'borsa', 'dolar', 'euro', 'faiz', 'enflasyon',
    'seçim', 'parti', 'milletvekili', 'cumhurbaşkanı',
];
// RSS kaynakları
const RSS_SOURCES = [
    {
        url: 'https://www.ntv.com.tr/gundem.rss',
        source: 'NTV',
    },
    {
        url: 'https://www.hurriyet.com.tr/rss/gundem',
        source: 'Hürriyet',
    },
    {
        url: 'https://www.cnnturk.com/feed/rss/turkiye/news',
        source: 'CNN Türk',
    },
    {
        url: 'https://www.sabah.com.tr/rss/gundem.xml',
        source: 'Sabah',
    },
];
function detectRegion(text) {
    const lowerText = text.toLowerCase();
    for (const [city, region] of Object.entries(CITY_REGION_MAP)) {
        if (lowerText.includes(city)) {
            return region;
        }
    }
    return 'Türkiye Geneli';
}
function detectCategory(text) {
    const lower = text.toLowerCase();
    if (lower.includes('risk') || lower.includes('uyarı') || lower.includes('tehlike')) {
        return 'Risk';
    }
    if (lower.includes('söndürme') || lower.includes('müdahale') || lower.includes('operasyon') || lower.includes('itfaiye')) {
        return 'Operasyon';
    }
    if (lower.includes('güvenlik') || lower.includes('tahliye') || lower.includes('önlem') || lower.includes('yasak')) {
        return 'Güvenlik';
    }
    return 'Güncelleme';
}
function isFireRelated(text) {
    const lower = text.toLowerCase();
    // Engelli keyword varsa reddet
    const hasBlocked = BLOCKED_KEYWORDS.some(kw => lower.includes(kw));
    if (hasBlocked)
        return false;
    // Yangın keyword'ü varsa kabul et
    return FIRE_KEYWORDS.some(kw => lower.includes(kw));
}
function estimateReadMinutes(text) {
    const wordCount = text.split(' ').length;
    return Math.max(1, Math.ceil(wordCount / 200));
}
async function fetchRSS(url) {
    try {
        const response = await axios_1.default.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'FireWatch TR News Bot 1.0',
            },
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
        // Her 6 saatte bir çalış
        node_cron_1.default.schedule('0 */6 * * *', async () => {
            await this.runScraper();
        });
        // Başlangıçta da çalıştır
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
                    // Yangınla ilgili mi?
                    if (!isFireRelated(fullText))
                        continue;
                    const region = detectRegion(fullText);
                    const category = detectCategory(fullText);
                    const readMinutes = estimateReadMinutes(summary);
                    const isBreaking = fullText.toLowerCase().includes('son dakika');
                    try {
                        await newsService_1.default.createNews({
                            title: title.trim(),
                            summary: summary.replace(/<[^>]*>/g, '').trim(), // HTML temizle
                            body: summary.replace(/<[^>]*>/g, '').trim(),
                            source: source.source,
                            source_url: link,
                            source_id: link, // duplicate önlemek için
                            category,
                            is_breaking: isBreaking,
                            published_at: pubDate,
                            read_minutes: readMinutes,
                            related_region: region,
                            highlights: [],
                            paragraphs: [],
                        });
                        totalAdded++;
                        console.log(`✅ Added: ${title.substring(0, 50)}...`);
                    }
                    catch (err) {
                        // Duplicate hatası → zaten var, geç
                        if (err.code === '23505') {
                            console.log(`⏭️ Duplicate, skipping: ${title.substring(0, 40)}`);
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
