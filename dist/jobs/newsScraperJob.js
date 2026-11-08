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
exports.checkRelevance = void 0;
const node_cron_1 = __importDefault(require("node-cron"));
const axios_1 = __importDefault(require("axios"));
const xml2js = __importStar(require("xml2js"));
const jobRunRecorder_1 = require("../services/jobRunRecorder");
const newsService_1 = __importDefault(require("../services/newsService"));
const turkishText_1 = require("../utils/turkishText");
const newsRelevance_1 = require("../utils/newsRelevance");
Object.defineProperty(exports, "checkRelevance", { enumerable: true, get: function () { return newsRelevance_1.checkRelevance; } });
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
// region null = otomatik tespit, string = sabit bölge
const RSS_SOURCES = [
    // Ulusal
    { url: 'https://www.ntv.com.tr/turkiye.rss', source: 'NTV Türkiye', region: null },
    { url: 'https://www.hurriyet.com.tr/rss/gundem', source: 'Hürriyet', region: null },
    { url: 'https://www.cnnturk.com/feed/rss/turkiye/news', source: 'CNN Türk', region: null },
    { url: 'https://www.sabah.com.tr/rss/gundem.xml', source: 'Sabah', region: null },
    { url: 'https://www.milliyet.com.tr/rss/rssNew/gundemRss.xml', source: 'Milliyet', region: null },
    { url: 'https://www.haberturk.com/rss/haber/gundem.xml', source: 'Haberturk', region: null },
    { url: 'https://www.trthaber.com/sondakika.rss', source: 'TRT Haber', region: null },
    { url: 'https://www.aa.com.tr/tr/rss/default?cat=guncel', source: 'AA', region: null },
    { url: 'https://www.sozcu.com.tr/rss/', source: 'Sözcü', region: null },
    // Bölgesel
    { url: 'https://www.izmirhaber.com.tr/rss', source: 'İzmir Haber', region: 'Ege' },
    { url: 'https://www.bursahaber.com/rss', source: 'Bursa Haber', region: 'Marmara' },
];
function detectRegion(text) {
    const lower = (0, turkishText_1.turkishToLower)(text);
    for (const [city, region] of Object.entries(CITY_REGION_MAP)) {
        if (lower.includes(city))
            return region;
    }
    return 'Türkiye Geneli';
}
function detectCategory(text) {
    const lower = (0, turkishText_1.turkishToLower)(text);
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
function estimateReadMinutes(text) {
    const wordCount = text.split(' ').length;
    return Math.max(1, Math.ceil(wordCount / 200));
}
// Several Turkish news sites front their RSS feeds with Cloudflare/WAF bot
// detection that 403s anything identifying itself as a bot (and, in some
// cases, cloud-hosting IP ranges like Render's regardless of UA). A
// browser-like User-Agent + Accept header clears the ones that filter on
// UA; a source that's still blocked simply contributes 0 items for that
// run rather than failing the whole scrape, since fetchRSS always resolves.
async function fetchRSS(url) {
    try {
        const response = await axios_1.default.get(url, {
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                Accept: 'application/rss+xml, application/xml, text/xml, */*',
            },
        });
        const parsed = await xml2js.parseStringPromise(response.data, {
            explicitArray: false,
        });
        const items = parsed?.rss?.channel?.item || [];
        return Array.isArray(items) ? items : [items];
    }
    catch (error) {
        console.error(`RSS fetch error for ${url}:`, error.message);
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
        const startedAt = new Date();
        console.log('🔍 Running news scraper at:', new Date().toISOString());
        let totalAdded = 0;
        let totalFetched = 0;
        const filterCounts = {
            no_must_have: 0,
            blocked: 0,
            too_short: 0,
            not_wildfire: 0,
            foreign: 0,
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
                    const relevance = (0, newsRelevance_1.checkRelevance)(title, fullText);
                    filterCounts[relevance.reason]++;
                    if (!relevance.relevant)
                        continue;
                    // Bölgesel kaynak ise sabit region, yoksa otomatik tespit
                    const region = source.region ?? detectRegion(fullText);
                    const category = detectCategory(fullText);
                    const readMinutes = estimateReadMinutes(summary);
                    const isBreaking = (0, turkishText_1.turkishToLower)(fullText).includes('son dakika');
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
        await (0, jobRunRecorder_1.recordJobRun)('news_scrape', startedAt, totalFetched > 0 ? 'ok' : 'failed', {
            fetched: totalFetched,
            passed: filterCounts.ok,
            added: totalAdded,
        });
        console.log(`✅ Scraper done. Fetched: ${totalFetched} | Passed whitelist: ${filterCounts.ok} | Added (new): ${totalAdded}`);
        console.log(`   Filter breakdown — no must-have keyword in title: ${filterCounts.no_must_have}, ` +
            `blocked: ${filterCounts.blocked}, not a wildfire: ${filterCounts.not_wildfire}, abroad: ${filterCounts.foreign}, passed: ${filterCounts.ok}`);
    }
}
exports.default = new NewsScraperJob();
