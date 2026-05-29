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

// Yangın keyword'ü MUTLAKA bunlardan biri olmalı
const MUST_HAVE_KEYWORDS = [
  'yangın', 'orman yangın', 'yanıyor', 'yandı',
  'alevler', 'itfaiye', 'afad yangın', 'ogm yangın',
  'yangın çıktı', 'yangın söndür', 'yangın riski',
];

// Ek yangın keywordleri (must_have ile birlikte)
const FIRE_KEYWORDS = [
  'söndürme', 'tahliye', 'kuraklık', 'meteoroloji uyarı',
  'orman', 'ormanlık', 'yangın ekibi',
];

// Kesinlikle engellenecek keywordler
const BLOCKED_KEYWORDS = [
  'öldürüldü', 'öldürdü', 'cinayet', 'katil', 'ceset',
  'öldü', 'hayatını kaybetti', 'can kaybı',
  'deprem', 'sel', 'heyelan', 'çığ', 'tsunami',
  'trafik kazası', 'çarpıştı', 'devrildi',
  'futbol', 'basketbol', 'maç', 'gol', 'şampiyon', 'transfer', 'lig',
  'dizi', 'film', 'müzik', 'şarkı', 'konser', 'magazin',
  'borsa', 'dolar', 'euro', 'faiz', 'enflasyon', 'ekonomi',
  'seçim', 'parti', 'milletvekili', 'meclis', 'hükümet',
  'evlilik', 'boşanma', 'bebek', 'hamile',
];

const RSS_SOURCES = [
  { url: 'https://www.ntv.com.tr/gundem.rss', source: 'NTV' },
  { url: 'https://www.hurriyet.com.tr/rss/gundem', source: 'Hürriyet' },
  { url: 'https://www.cnnturk.com/feed/rss/turkiye/news', source: 'CNN Türk' },
  { url: 'https://www.sabah.com.tr/rss/gundem.xml', source: 'Sabah' },
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

function isFireRelated(text: string): boolean {
  const lower = text.toLowerCase();

  // 1. Engellenmiş keyword varsa KESINLIKLE reddet
  if (BLOCKED_KEYWORDS.some(kw => lower.includes(kw))) return false;

  // 2. MUTLAKA yangın kelimesi geçmeli
  if (!MUST_HAVE_KEYWORDS.some(kw => lower.includes(kw))) return false;

  return true;
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

          if (!isFireRelated(fullText)) continue;

          const region = detectRegion(fullText);
          const category = detectCategory(fullText);
          const readMinutes = estimateReadMinutes(summary);
          const isBreaking = fullText.toLowerCase().includes('son dakika');
          const cleanSummary = summary.replace(/<[^>]*>/g, '').trim();

          try {
            await newsService.createNews({
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
          } catch (err: any) {
            if (err.code === '23505') {
              console.log(`⏭️ Duplicate: ${title.substring(0, 40)}`);
            } else {
              console.error(`❌ DB error:`, err.message);
            }
          }
        }
      } catch (error) {
        console.error(`❌ Error processing ${source.source}:`, error);
      }
    }

    console.log(`✅ Scraper done. Total added: ${totalAdded}`);
  }
}

export default new NewsScraperJob();