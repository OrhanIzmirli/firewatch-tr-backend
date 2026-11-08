"use strict";
/**
 * Which news sources the backend may read automatically. Decided by the
 * source audit of 2026-11-08 (each source's terms and robots.txt). Only a
 * headline, the source's name and a link are kept; text is never stored.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.REMOVED_NEWS_SOURCES = exports.RSS_SOURCES = exports.NEWS_USER_AGENT = void 0;
exports.isRemovedDomain = isRemovedDomain;
/** Client identity. Never pretend to be a browser: a source that refuses bots is respected. */
exports.NEWS_USER_AGENT = 'FireWatchTR/1.2 (wildfire information app; firewatch.tr@gmail.com)';
/** Publishers offering RSS whose pages do not forbid automated reading. */
exports.RSS_SOURCES = [
    { url: 'https://www.izmirhaber.com.tr/rss', source: 'İzmir Haber', region: 'Ege' },
    { url: 'https://www.bursahaber.com/rss', source: 'Bursa Haber', region: 'Marmara' },
];
/** Names under which sources removed by the audit were stored; never shown again. */
exports.REMOVED_NEWS_SOURCES = [
    'NTV Türkiye', 'Hürriyet', 'CNN Türk', 'Sabah', 'Milliyet', 'Haberturk', 'TRT Haber', 'AA', 'Sözcü',
];
/** The same publishers' sites: GDELT lists them too, and they stay out that way as well. */
const REMOVED_DOMAINS = [
    'ntv.com.tr', 'hurriyet.com.tr', 'cnnturk.com', 'sabah.com.tr', 'milliyet.com.tr',
    'haberturk.com', 'trthaber.com', 'trt.net.tr', 'aa.com.tr', 'sozcu.com.tr',
];
function isRemovedDomain(domain) {
    const d = domain.toLowerCase().replace(/^www\./, '');
    return REMOVED_DOMAINS.some((r) => d === r || d.endsWith(`.${r}`));
}
