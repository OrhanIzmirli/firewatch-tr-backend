import cron from 'node-cron';
import axios from 'axios';
import * as xml2js from 'xml2js';
import { recordJobRun } from '../services/jobRunRecorder';
import newsService from '../services/newsService';
import { turkishToLower } from '../utils/turkishText';
import { RelevanceResult, checkRelevance } from '../utils/newsRelevance';
import { NEWS_USER_AGENT, RSS_SOURCES } from '../config/newsSources';
import { fetchAfadHeadlines, fetchGdeltHeadlines } from '../services/newsFetchers';

// Re-exported: server.ts's /api/admin/clean-news imports it from here.
export { checkRelevance };

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

function detectRegion(text: string): string {
  const lower = turkishToLower(text);
  for (const [city, region] of Object.entries(CITY_REGION_MAP)) {
    if (lower.includes(city)) return region;
  }
  return 'Türkiye Geneli';
}

function detectCategory(text: string): string {
  const lower = turkishToLower(text);
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
async function fetchRSS(url: string): Promise<any[]> {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': NEWS_USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    const parsed = await xml2js.parseStringPromise(response.data, { explicitArray: false });
    const items = parsed?.rss?.channel?.item || [];
    return Array.isArray(items) ? items : [items];
  } catch (error) {
    console.error(`RSS fetch error for ${url}:`, (error as Error).message);
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
    const startedAt = new Date();
    console.log('🔍 Running news scraper at:', new Date().toISOString());
    let totalAdded = 0;
    let totalFetched = 0;
    const filterCounts: Record<RelevanceResult['reason'], number> = {
      no_must_have: 0,
      blocked: 0,
      too_short: 0,
      not_wildfire: 0,
      foreign: 0,
      ok: 0,
    };

    const headlines: { title: string; text: string; link: string; source: string; region: string | null; at: Date }[] = [];
    for (const source of RSS_SOURCES) {
      const items = await fetchRSS(source.url);
      console.log(`📰 ${source.source}: ${items.length} items found`);
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
    for (const h of [...(await fetchGdeltHeadlines()), ...(await fetchAfadHeadlines())]) {
      headlines.push({ title: h.title, text: '', link: h.link, source: h.source, region: null, at: h.publishedAt });
    }
    totalFetched = headlines.length;

    for (const h of headlines) {
      const fullText = `${h.title} ${h.text}`;
      const relevance = checkRelevance(h.title, fullText);
      filterCounts[relevance.reason]++;
      if (!relevance.relevant || !h.link) continue;
      try {
        const created = await newsService.createNews({
          title: h.title.trim().slice(0, 255),
          summary: '',
          body: '',
          source: h.source.slice(0, 100),
          source_url: h.link.slice(0, 500),
          source_id: h.link.slice(0, 500),
          category: detectCategory(fullText),
          is_breaking: turkishToLower(h.title).includes('son dakika'),
          published_at: h.at,
          read_minutes: 1,
          related_region: h.region ?? detectRegion(fullText),
          highlights: [],
          paragraphs: [],
        } as any);
        if (created) totalAdded++;
      } catch (err: any) {
        console.error('❌ DB error:', err.message);
      }
    }

    await recordJobRun('news_scrape', startedAt, totalFetched > 0 ? 'ok' : 'failed', {
      fetched: totalFetched,
      passed: filterCounts.ok,
      added: totalAdded,
    });
    console.log(
      `✅ Scraper done. Fetched: ${totalFetched} | Passed whitelist: ${filterCounts.ok} | Added (new): ${totalAdded}`
    );
    console.log(
      `   Filter breakdown — no must-have keyword in title: ${filterCounts.no_must_have}, ` +
      `blocked: ${filterCounts.blocked}, not a wildfire: ${filterCounts.not_wildfire}, abroad: ${filterCounts.foreign}, passed: ${filterCounts.ok}`
    );
  }
}

export default new NewsScraperJob();
