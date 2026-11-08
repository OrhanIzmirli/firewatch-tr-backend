import axios from 'axios';
import { NEWS_USER_AGENT, OFFICIAL_SOURCES, isRemovedDomain } from '../config/newsSources';

export interface FetchedHeadline {
  title: string;
  link: string;
  source: string;
  publishedAt: Date;
}

const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_QUERY = '("orman yangını" OR "orman yangınına" OR "orman yangınında" OR "ormanlık alanda yangın") sourcelang:turkish';
/** Longer than the two hours between scrapes, so one refused run loses nothing. */
const GDELT_WINDOW = '6h';

/** GDELT's "20261108T123000Z". */
export function parseGdeltDate(s: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s ?? '');
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

export function parseGdelt(json: unknown): FetchedHeadline[] {
  const articles = (json as { articles?: unknown[] } | null)?.articles;
  if (!Array.isArray(articles)) return [];
  const out: FetchedHeadline[] = [];
  for (const raw of articles) {
    const a = raw as { title?: string; url?: string; domain?: string; seendate?: string };
    const when = parseGdeltDate(a.seendate ?? '');
    if (!a.title || !a.url || !a.domain || !when || isRemovedDomain(a.domain)) continue;
    out.push({ title: a.title.trim(), link: a.url, source: a.domain.replace(/^www\./, ''), publishedAt: when });
  }
  return out;
}

/** AFAD and valilik pages list news as cards: link, date as dd.mm.yyyy, title. */
export function parseCards(html: string, source: string, pageUrl: string): FetchedHeadline[] {
  const card = /<a[^>]+href="([^"]+)"[^>]*>\s*<div class="card-img">[\s\S]*?class="cardDate">(\d{2})\.(\d{2})\.(\d{4})<[\s\S]*?class="card-title">([^<]+)</g;
  const out: FetchedHeadline[] = [];
  for (const m of html.matchAll(card)) {
    const link = m[1].startsWith('//') ? `https:${m[1]}` : new URL(m[1], pageUrl).toString();
    out.push({ title: m[5].trim(), link, source, publishedAt: new Date(Date.UTC(+m[4], +m[3] - 1, +m[2], 9)) });
  }
  return out;
}

/** OGM pages carry their list as data inside the page. */
export function parseOgm(html: string, source: string, pageUrl: string): FetchedHeadline[] {
  const item = /\{Title: "((?:[^"\\]|\\.)*)",Description:[\s\S]*?Link: "([^"]+)"[\s\S]*?Date: new Date\("([^"]+)"\)\}/g;
  const out: FetchedHeadline[] = [];
  for (const m of html.matchAll(item)) {
    const when = new Date(m[3]);
    if (Number.isNaN(when.getTime())) continue;
    out.push({ title: m[1].replace(/\\"/g, '"').trim(), link: new URL(m[2], pageUrl).toString(), source, publishedAt: when });
  }
  return out;
}

export interface GdeltResult {
  headlines: FetchedHeadline[];
  /** ok, empty, rate_limited or the error text: stored with each job run. */
  status: string;
  raw: number;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One query per scrape. GDELT asks for at most one request every five
 * seconds and answers 429 past that; a refused request is retried once
 * after a pause, then left for the next run, which overlaps this window.
 */
export async function fetchGdeltHeadlines(): Promise<GdeltResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data, status } = await axios.get(GDELT_URL, {
        timeout: 20000,
        validateStatus: () => true,
        headers: { 'User-Agent': NEWS_USER_AGENT },
        params: { query: GDELT_QUERY, mode: 'ArtList', format: 'json', maxrecords: 100, timespan: GDELT_WINDOW, sort: 'DateDesc' },
      });
      if (status === 429) {
        if (attempt === 0) {
          await wait(15000);
          continue;
        }
        return { headlines: [], status: 'rate_limited', raw: 0 };
      }
      if (status !== 200) return { headlines: [], status: `http_${status}`, raw: 0 };
      const raw = Array.isArray(data?.articles) ? data.articles.length : 0;
      return { headlines: parseGdelt(data), status: raw === 0 ? 'empty' : 'ok', raw };
    } catch (error) {
      console.error('GDELT fetch error:', (error as Error).message);
      return { headlines: [], status: (error as Error).message.slice(0, 80), raw: 0 };
    }
  }
  return { headlines: [], status: 'rate_limited', raw: 0 };
}

/** One page at a time, with a pause: these are small public institutions. */
export async function fetchOfficialHeadlines(): Promise<{ headlines: FetchedHeadline[]; failed: number }> {
  const headlines: FetchedHeadline[] = [];
  let failed = 0;
  for (const page of OFFICIAL_SOURCES) {
    try {
      const { data } = await axios.get<string>(page.url, { timeout: 15000, responseType: 'text', headers: { 'User-Agent': NEWS_USER_AGENT } });
      headlines.push(...(page.format === 'ogm' ? parseOgm(data, page.source, page.url) : parseCards(data, page.source, page.url)));
    } catch {
      failed++;
    }
    await wait(1000);
  }
  return { headlines, failed };
}
