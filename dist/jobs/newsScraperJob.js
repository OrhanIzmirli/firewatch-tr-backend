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
const newsSources_1 = require("../config/newsSources");
const newsFetchers_1 = require("../services/newsFetchers");
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
// A source that refuses this honest client contributes nothing for that run;
// the old browser-like User-Agent, which got past such refusals, is gone.
async function fetchRSS(url) {
    try {
        const response = await axios_1.default.get(url, {
            timeout: 10000,
            headers: { 'User-Agent': newsSources_1.NEWS_USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
        });
        const parsed = await xml2js.parseStringPromise(response.data, { explicitArray: false });
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
        node_cron_1.default.schedule('0 */2 * * *', async () => {
            await this.runScraper();
        });
        this.runScraper(true);
    }
    async runScraper(includeOfficial = false) {
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
        const rssCounts = {};
        const headlines = [];
        for (const source of newsSources_1.RSS_SOURCES) {
            const items = await fetchRSS(source.url);
            console.log(`📰 ${source.source}: ${items.length} items found`);
            rssCounts[source.source] = items.length;
            for (const item of items) {
                headlines.push({
                    title: String(item.title || ''),
                    // Read only to decide relevance; never stored.
                    text: String(item.description || ''),
                    link: String(item.link || ''),
                    source: source.source,
                    region: source.region,
                    at: item.pubDate ? new Date(item.pubDate) : new Date(),
                });
            }
        }
        const gdelt = await (0, newsFetchers_1.fetchGdeltHeadlines)();
        // Official pages change slowly: every third run is enough.
        const official = includeOfficial || new Date().getUTCHours() % 6 < 2 ? await (0, newsFetchers_1.fetchOfficialHeadlines)() : { headlines: [], failed: 0 };
        const bySource = { gdelt: gdelt.headlines.length, official: official.headlines.length, official_failed: official.failed };
        for (const h of [...gdelt.headlines, ...official.headlines]) {
            headlines.push({ title: h.title, text: '', link: h.link, source: h.source, region: null, at: h.publishedAt });
        }
        totalFetched = headlines.length;
        for (const h of headlines) {
            const fullText = `${h.title} ${h.text}`;
            const relevance = (0, newsRelevance_1.checkRelevance)(h.title, fullText);
            filterCounts[relevance.reason]++;
            if (!relevance.relevant || !h.link)
                continue;
            try {
                const created = await newsService_1.default.createNews({
                    title: h.title.trim().slice(0, 255),
                    summary: '',
                    body: '',
                    source: h.source.slice(0, 100),
                    source_url: h.link.slice(0, 500),
                    source_id: h.link.slice(0, 500),
                    category: detectCategory(fullText),
                    is_breaking: (0, turkishText_1.turkishToLower)(h.title).includes('son dakika'),
                    published_at: h.at,
                    read_minutes: 1,
                    related_region: h.region ?? detectRegion(fullText),
                    highlights: [],
                    paragraphs: [],
                });
                if (created)
                    totalAdded++;
            }
            catch (err) {
                console.error('❌ DB error:', err.message);
            }
        }
        await (0, jobRunRecorder_1.recordJobRun)('news_scrape', startedAt, totalFetched > 0 ? 'ok' : 'failed', {
            fetched: totalFetched,
            passed: filterCounts.ok,
            added: totalAdded,
            gdelt_status: gdelt.status,
            gdelt_raw: gdelt.raw,
            by_source: { ...rssCounts, ...bySource },
        });
        console.log(`✅ Scraper done. Fetched: ${totalFetched} | Passed whitelist: ${filterCounts.ok} | Added (new): ${totalAdded}`);
        console.log(`   Filter breakdown — no must-have keyword in title: ${filterCounts.no_must_have}, ` +
            `blocked: ${filterCounts.blocked}, not a wildfire: ${filterCounts.not_wildfire}, abroad: ${filterCounts.foreign}, passed: ${filterCounts.ok}`);
    }
}
exports.default = new NewsScraperJob();
