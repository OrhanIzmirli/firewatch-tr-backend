"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NominatimQueue = exports.PlaceSearchError = exports.NOMINATIM_DEFAULT_URL = exports.NOMINATIM_USER_AGENT = exports.NOMINATIM_MAX_QUEUE = exports.NOMINATIM_MIN_INTERVAL_MS = exports.SEARCH_CACHE_TTL_SECONDS = exports.SEARCH_RESULT_LIMIT = exports.SEARCH_QUERY_MAX = exports.SEARCH_QUERY_MIN = void 0;
exports.parseSearchQuery = parseSearchQuery;
exports.searchCacheKey = searchCacheKey;
exports.parseNominatim = parseNominatim;
exports.searchPlaces = searchPlaces;
const crypto_1 = __importDefault(require("crypto"));
const axios_1 = __importDefault(require("axios"));
const cacheService_1 = __importDefault(require("./cacheService"));
const trackedPlaces_1 = require("./trackedPlaces");
const turkishText_1 = require("../utils/turkishText");
/**
 * Address and neighbourhood search for "Yerlerim", through OSM Nominatim.
 *
 * Follows https://operations.osmfoundation.org/policies/nominatim/ :
 *   - at most one request per second for the whole app: every lookup goes
 *     through the single queue below (one instance, one queue);
 *   - an identifying User-Agent, never a library default;
 *   - results are cached, and repeated queries are answered from the cache;
 *   - only ever triggered by a person pressing "Ara": no autocomplete;
 *   - NOMINATIM_BASE_URL and NOMINATIM_ENABLED let the service be switched
 *     or turned off without an app update, as the policy requires;
 *   - the app shows the attribution next to the results.
 *
 * Privacy: the query arrives in a POST body, so it cannot reach the access
 * log, and it is never logged here. The cache key is a SHA-256 of the
 * normalised query; the query text itself is stored nowhere.
 */
exports.SEARCH_QUERY_MIN = 3;
exports.SEARCH_QUERY_MAX = 120;
exports.SEARCH_RESULT_LIMIT = 5;
exports.SEARCH_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Slightly over a second, so clock jitter cannot produce two in one second. */
exports.NOMINATIM_MIN_INTERVAL_MS = 1100;
/** More waiting than this and the person is better off retrying. */
exports.NOMINATIM_MAX_QUEUE = 5;
exports.NOMINATIM_USER_AGENT = 'firewatch-tr-backend/1.0 (+https://github.com/OrhanIzmirli/firewatch-tr-backend)';
exports.NOMINATIM_DEFAULT_URL = 'https://nominatim.openstreetmap.org';
class PlaceSearchError extends Error {
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
exports.PlaceSearchError = PlaceSearchError;
/** Trims, folds whitespace, drops control characters. Null when unusable. */
function parseSearchQuery(value) {
    if (typeof value !== 'string')
        return null;
    const cleaned = value
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
    const length = [...cleaned].length;
    return length >= exports.SEARCH_QUERY_MIN && length <= exports.SEARCH_QUERY_MAX ? cleaned : null;
}
/** Same text, different case or spacing: same cache entry. */
function searchCacheKey(query) {
    const digest = crypto_1.default.createHash('sha256').update((0, turkishText_1.turkishToLower)(query)).digest('hex');
    return `geocode:v1:${digest}`;
}
/** Drops the country, which is always Türkiye here, and postal codes. */
function shortenLabel(displayName) {
    const parts = displayName
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p !== '' && p !== 'Türkiye' && !/^\d{5}$/.test(p));
    return parts.slice(0, 4).join(', ');
}
/** Keeps well-formed results inside Türkiye; anything else is dropped. */
function parseNominatim(body) {
    if (!Array.isArray(body))
        return [];
    const results = [];
    for (const raw of body) {
        const latitude = Number(raw?.lat);
        const longitude = Number(raw?.lon);
        const displayName = typeof raw?.display_name === 'string' ? raw.display_name : '';
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || displayName === '')
            continue;
        if (!(0, trackedPlaces_1.isWithinTurkeyBbox)(latitude, longitude))
            continue;
        const label = shortenLabel(displayName);
        const name = (typeof raw?.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : label.split(',')[0]).slice(0, 40);
        results.push({ name, label, latitude, longitude });
    }
    return results.slice(0, exports.SEARCH_RESULT_LIMIT);
}
/**
 * One queue per process. A request starts only after the previous one
 * started at least NOMINATIM_MIN_INTERVAL_MS ago.
 */
class NominatimQueue {
    constructor(wait, now) {
        this.wait = wait;
        this.now = now;
        this.tail = Promise.resolve();
        this.waiting = 0;
        this.lastStart = 0;
    }
    run(task) {
        if (this.waiting >= exports.NOMINATIM_MAX_QUEUE)
            return Promise.reject(new PlaceSearchError('busy'));
        this.waiting++;
        const job = this.tail.then(async () => {
            const gap = this.lastStart + exports.NOMINATIM_MIN_INTERVAL_MS - this.now();
            if (gap > 0)
                await this.wait(gap);
            this.lastStart = this.now();
            try {
                return await task();
            }
            finally {
                this.waiting--;
            }
        });
        this.tail = job.catch(() => undefined);
        return job;
    }
}
exports.NominatimQueue = NominatimQueue;
const defaultDeps = {
    http: axios_1.default,
    cache: cacheService_1.default,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    env: process.env,
};
const sharedQueue = new NominatimQueue(defaultDeps.wait, defaultDeps.now);
async function searchPlaces(query, deps = defaultDeps, queue = sharedQueue) {
    if (deps.env.NOMINATIM_ENABLED === 'false')
        throw new PlaceSearchError('disabled');
    const key = searchCacheKey(query);
    const cached = await deps.cache.get(key);
    if (cached)
        return cached;
    const baseUrl = (deps.env.NOMINATIM_BASE_URL || exports.NOMINATIM_DEFAULT_URL).replace(/\/+$/, '');
    let body;
    try {
        const response = await queue.run(() => deps.http.get(`${baseUrl}/search`, {
            params: {
                q: query,
                format: 'jsonv2',
                countrycodes: 'tr',
                'accept-language': 'tr',
                limit: exports.SEARCH_RESULT_LIMIT,
            },
            headers: { 'User-Agent': exports.NOMINATIM_USER_AGENT },
            timeout: 10000,
        }));
        body = response.data;
    }
    catch (error) {
        if (error instanceof PlaceSearchError)
            throw error;
        // The status only: the error's config would carry the query text.
        const status = error.response?.status;
        console.error(`Nominatim search failed: ${status ?? 'no response'}`);
        throw new PlaceSearchError('upstream');
    }
    const results = parseNominatim(body);
    await deps.cache.set(key, results, exports.SEARCH_CACHE_TTL_SECONDS);
    return results;
}
