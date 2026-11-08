"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseGdeltDate = parseGdeltDate;
exports.parseGdelt = parseGdelt;
exports.parseCards = parseCards;
exports.parseOgm = parseOgm;
exports.fetchGdeltHeadlines = fetchGdeltHeadlines;
exports.fetchOfficialHeadlines = fetchOfficialHeadlines;
const axios_1 = __importDefault(require("axios"));
const newsSources_1 = require("../config/newsSources");
const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_QUERY = '("orman yangını" OR "orman yangınına" OR "orman yangınında" OR "ormanlık alanda yangın") sourcelang:turkish';
/** Longer than the two hours between scrapes, so one refused run loses nothing. */
const GDELT_WINDOW = '6h';
/** GDELT's "20261108T123000Z". */
function parseGdeltDate(s) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s ?? '');
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}
function parseGdelt(json) {
    const articles = json?.articles;
    if (!Array.isArray(articles))
        return [];
    const out = [];
    for (const raw of articles) {
        const a = raw;
        const when = parseGdeltDate(a.seendate ?? '');
        if (!a.title || !a.url || !a.domain || !when || (0, newsSources_1.isRemovedDomain)(a.domain))
            continue;
        out.push({ title: a.title.trim(), link: a.url, source: a.domain.replace(/^www\./, ''), publishedAt: when });
    }
    return out;
}
/** AFAD and valilik pages list news as cards: link, date as dd.mm.yyyy, title. */
function parseCards(html, source, pageUrl) {
    const card = /<a[^>]+href="([^"]+)"[^>]*>\s*<div class="card-img">[\s\S]*?class="cardDate">(\d{2})\.(\d{2})\.(\d{4})<[\s\S]*?class="card-title">([^<]+)</g;
    const out = [];
    for (const m of html.matchAll(card)) {
        const link = m[1].startsWith('//') ? `https:${m[1]}` : new URL(m[1], pageUrl).toString();
        out.push({ title: m[5].trim(), link, source, publishedAt: new Date(Date.UTC(+m[4], +m[3] - 1, +m[2], 9)) });
    }
    return out;
}
/** OGM pages carry their list as data inside the page. */
function parseOgm(html, source, pageUrl) {
    const item = /\{Title: "((?:[^"\\]|\\.)*)",Description:[\s\S]*?Link: "([^"]+)"[\s\S]*?Date: new Date\("([^"]+)"\)\}/g;
    const out = [];
    for (const m of html.matchAll(item)) {
        const when = new Date(m[3]);
        if (Number.isNaN(when.getTime()))
            continue;
        out.push({ title: m[1].replace(/\\"/g, '"').trim(), link: new URL(m[2], pageUrl).toString(), source, publishedAt: when });
    }
    return out;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * One query per scrape. GDELT asks for at most one request every five
 * seconds and answers 429 past that; a refused request is retried once
 * after a pause, then left for the next run, which overlaps this window.
 */
async function fetchGdeltHeadlines() {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const { data, status } = await axios_1.default.get(GDELT_URL, {
                timeout: 20000,
                validateStatus: () => true,
                headers: { 'User-Agent': newsSources_1.NEWS_USER_AGENT },
                params: { query: GDELT_QUERY, mode: 'ArtList', format: 'json', maxrecords: 100, timespan: GDELT_WINDOW, sort: 'DateDesc' },
            });
            if (status === 429) {
                if (attempt === 0) {
                    await wait(15000);
                    continue;
                }
                return { headlines: [], status: 'rate_limited', raw: 0 };
            }
            if (status !== 200)
                return { headlines: [], status: `http_${status}`, raw: 0 };
            const raw = Array.isArray(data?.articles) ? data.articles.length : 0;
            return { headlines: parseGdelt(data), status: raw === 0 ? 'empty' : 'ok', raw };
        }
        catch (error) {
            console.error('GDELT fetch error:', error.message);
            return { headlines: [], status: error.message.slice(0, 80), raw: 0 };
        }
    }
    return { headlines: [], status: 'rate_limited', raw: 0 };
}
/** One page at a time, with a pause: these are small public institutions. */
async function fetchOfficialHeadlines() {
    const headlines = [];
    let failed = 0;
    for (const page of newsSources_1.OFFICIAL_SOURCES) {
        try {
            const { data } = await axios_1.default.get(page.url, { timeout: 15000, responseType: 'text', headers: { 'User-Agent': newsSources_1.NEWS_USER_AGENT } });
            headlines.push(...(page.format === 'ogm' ? parseOgm(data, page.source, page.url) : parseCards(data, page.source, page.url)));
        }
        catch {
            failed++;
        }
        await wait(1000);
    }
    return { headlines, failed };
}
