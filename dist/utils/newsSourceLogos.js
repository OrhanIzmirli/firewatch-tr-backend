"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NEWS_LOGO_DIR = exports.STATIC_MOUNT_PATH = void 0;
exports.newsLogoFiles = newsLogoFiles;
exports.sourceLogoUrl = sourceLogoUrl;
exports.withSourceLogo = withSourceLogo;
const turkishText_1 = require("./turkishText");
/**
 * Square logo for each RSS source, keyed by the `source` name the scraper
 * stores. Attached when news is read rather than stored in a column, so
 * rows scraped before this map existed get a logo too, and adding or
 * fixing an entry needs no migration or backfill.
 *
 * The files are served by this backend from public/news-logos (see the
 * /static mount in server.ts), never hotlinked: the app would otherwise
 * send every reader's IP to eight news sites, and a site changing its
 * favicon path would silently break the image. Each file was downloaded
 * once on 2026-11-06 and checked to be a real, square PNG (signature,
 * IHDR, IEND); scripts/test-news-source-logos.ts re-checks every file.
 *
 * Sources without a usable logo are left out on purpose and fall back to
 * the app's letter mark:
 *   - NTV Türkiye: www.ntv.com.tr answers 403 to non-browser requests.
 *   - İzmir Haber: its declared favicon path is a 404.
 *   - Bursa Haber: its only logo is 191x80, which a square crop mangles.
 *   - Sözcü: its favicon is a seasonal flag image, not the brand mark.
 */
const SOURCE_LOGO_FILES = {
    'Hürriyet': 'hurriyet.png',
    'CNN Türk': 'cnn-turk.png',
    'Sabah': 'sabah.png',
    'Milliyet': 'milliyet.png',
    'Haberturk': 'haberturk.png',
    'TRT Haber': 'trt-haber.png',
    'AA': 'aa.png',
};
/** URL path under which server.ts serves public/. */
exports.STATIC_MOUNT_PATH = '/static';
/** Directory under public/ holding the logo files. */
exports.NEWS_LOGO_DIR = 'news-logos';
const normalize = (name) => (0, turkishText_1.turkishToLower)(name).replace(/\s+/g, ' ').trim();
const FILES_BY_NORMALIZED_NAME = new Map(Object.entries(SOURCE_LOGO_FILES).map(([name, file]) => [normalize(name), file]));
/** Every logo file name the map refers to (for the file check in tests). */
function newsLogoFiles() {
    return Object.values(SOURCE_LOGO_FILES);
}
/**
 * PUBLIC_BASE_URL without a trailing slash, or '' when unset. Read on each
 * call so a missing variable degrades to "no logo" instead of a relative
 * URL the app cannot load.
 */
function publicBaseUrl() {
    return (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
}
/** Logo URL for a news source name, or '' when there is none. */
function sourceLogoUrl(source) {
    if (!source)
        return '';
    const file = FILES_BY_NORMALIZED_NAME.get(normalize(source));
    const base = publicBaseUrl();
    if (!file || !base)
        return '';
    return `${base}${exports.STATIC_MOUNT_PATH}/${exports.NEWS_LOGO_DIR}/${file}`;
}
/** Returns the row with `source_logo_url` filled in from its `source`. */
function withSourceLogo(row) {
    return { ...row, source_logo_url: sourceLogoUrl(row.source) };
}
