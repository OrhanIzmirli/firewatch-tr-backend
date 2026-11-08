"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseGdeltDate = parseGdeltDate;
exports.parseGdelt = parseGdelt;
exports.parseAfad = parseAfad;
exports.fetchGdeltHeadlines = fetchGdeltHeadlines;
exports.fetchAfadHeadlines = fetchAfadHeadlines;
const axios_1 = __importDefault(require("axios"));
const newsSources_1 = require("../config/newsSources");
const GDELT_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GDELT_QUERY = '("orman yangını" OR "orman yangınına" OR "orman yangınında" OR "ormanlık alanda yangın") sourcelang:turkish';
const AFAD_NEWS_URL = 'https://www.afad.gov.tr/haberler';
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
/** AFAD lists news as cards: link, date as dd.mm.yyyy, title. */
function parseAfad(html) {
    const card = /<a[^>]+href="([^"]+)"[^>]*>\s*<div class="card-img">[\s\S]*?class="cardDate">(\d{2})\.(\d{2})\.(\d{4})<[\s\S]*?class="card-title">([^<]+)</g;
    const out = [];
    for (const m of html.matchAll(card)) {
        const link = m[1].startsWith('//') ? `https:${m[1]}` : new URL(m[1], AFAD_NEWS_URL).toString();
        out.push({ title: m[5].trim(), link, source: 'AFAD', publishedAt: new Date(Date.UTC(+m[4], +m[3] - 1, +m[2], 9)) });
    }
    return out;
}
/** One query per scrape: GDELT allows one request every five seconds. */
async function fetchGdeltHeadlines() {
    try {
        const { data } = await axios_1.default.get(GDELT_URL, {
            timeout: 20000,
            headers: { 'User-Agent': newsSources_1.NEWS_USER_AGENT },
            params: { query: GDELT_QUERY, mode: 'ArtList', format: 'json', maxrecords: 100, timespan: '12h', sort: 'DateDesc' },
        });
        return parseGdelt(data);
    }
    catch (error) {
        console.error('GDELT fetch error:', error.message);
        return [];
    }
}
async function fetchAfadHeadlines() {
    try {
        const { data } = await axios_1.default.get(AFAD_NEWS_URL, {
            timeout: 15000,
            responseType: 'text',
            headers: { 'User-Agent': newsSources_1.NEWS_USER_AGENT },
        });
        return parseAfad(data);
    }
    catch (error) {
        console.error('AFAD fetch error:', error.message);
        return [];
    }
}
