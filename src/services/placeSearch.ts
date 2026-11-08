import crypto from 'crypto';
import axios from 'axios';
import cacheService from './cacheService';
import { isWithinTurkeyBbox } from './trackedPlaces';
import { turkishToLower } from '../utils/turkishText';

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

export const SEARCH_QUERY_MIN = 3;
export const SEARCH_QUERY_MAX = 120;
export const SEARCH_RESULT_LIMIT = 5;
export const SEARCH_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Slightly over a second, so clock jitter cannot produce two in one second. */
export const NOMINATIM_MIN_INTERVAL_MS = 1100;
/** More waiting than this and the person is better off retrying. */
export const NOMINATIM_MAX_QUEUE = 5;
export const NOMINATIM_USER_AGENT =
  'firewatch-tr-backend/1.0 (+https://github.com/OrhanIzmirli/firewatch-tr-backend)';
export const NOMINATIM_DEFAULT_URL = 'https://nominatim.openstreetmap.org';

export interface PlaceSearchResult {
  /** Short name for the form: "Zeytinalanı". */
  name: string;
  /** Full line for the list: "Zeytinalanı, Urla, İzmir". */
  label: string;
  latitude: number;
  longitude: number;
}

export type SearchFailure = 'disabled' | 'busy' | 'upstream';

export class PlaceSearchError extends Error {
  constructor(public readonly reason: SearchFailure) {
    super(reason);
  }
}

/** Trims, folds whitespace, drops control characters. Null when unusable. */
export function parseSearchQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const length = [...cleaned].length;
  return length >= SEARCH_QUERY_MIN && length <= SEARCH_QUERY_MAX ? cleaned : null;
}

/** Same text, different case or spacing: same cache entry. */
export function searchCacheKey(query: string): string {
  const digest = crypto.createHash('sha256').update(turkishToLower(query)).digest('hex');
  return `geocode:v1:${digest}`;
}

/** Drops the country, which is always Türkiye here, and postal codes. */
function shortenLabel(displayName: string): string {
  const parts = displayName
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== 'Türkiye' && !/^\d{5}$/.test(p));
  return parts.slice(0, 4).join(', ');
}

/** Keeps well-formed results inside Türkiye; anything else is dropped. */
export function parseNominatim(body: unknown): PlaceSearchResult[] {
  if (!Array.isArray(body)) return [];
  const results: PlaceSearchResult[] = [];
  for (const raw of body) {
    const latitude = Number(raw?.lat);
    const longitude = Number(raw?.lon);
    const displayName = typeof raw?.display_name === 'string' ? raw.display_name : '';
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || displayName === '') continue;
    if (!isWithinTurkeyBbox(latitude, longitude)) continue;
    const label = shortenLabel(displayName);
    const name = (typeof raw?.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : label.split(',')[0]).slice(0, 40);
    results.push({ name, label, latitude, longitude });
  }
  return results.slice(0, SEARCH_RESULT_LIMIT);
}

export interface NominatimHttp {
  get(url: string, config: {
    params: Record<string, string | number>;
    headers: Record<string, string>;
    timeout: number;
  }): Promise<{ data: unknown }>;
}

export interface SearchDeps {
  http: NominatimHttp;
  cache: { get<T>(key: string): Promise<T | null>; set<T>(key: string, value: T, ttl?: number): Promise<boolean> };
  wait: (ms: number) => Promise<void>;
  now: () => number;
  env: Record<string, string | undefined>;
}

/**
 * One queue per process. A request starts only after the previous one
 * started at least NOMINATIM_MIN_INTERVAL_MS ago.
 */
export class NominatimQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private lastStart = 0;

  constructor(private readonly wait: (ms: number) => Promise<void>, private readonly now: () => number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.waiting >= NOMINATIM_MAX_QUEUE) return Promise.reject(new PlaceSearchError('busy'));
    this.waiting++;
    const job = this.tail.then(async () => {
      const gap = this.lastStart + NOMINATIM_MIN_INTERVAL_MS - this.now();
      if (gap > 0) await this.wait(gap);
      this.lastStart = this.now();
      try {
        return await task();
      } finally {
        this.waiting--;
      }
    });
    this.tail = job.catch(() => undefined);
    return job;
  }
}

const defaultDeps: SearchDeps = {
  http: axios,
  cache: cacheService,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  env: process.env,
};

const sharedQueue = new NominatimQueue(defaultDeps.wait, defaultDeps.now);

export async function searchPlaces(
  query: string,
  deps: SearchDeps = defaultDeps,
  queue: NominatimQueue = sharedQueue
): Promise<PlaceSearchResult[]> {
  if (deps.env.NOMINATIM_ENABLED === 'false') throw new PlaceSearchError('disabled');

  const key = searchCacheKey(query);
  const cached = await deps.cache.get<PlaceSearchResult[]>(key);
  if (cached) return cached;

  const baseUrl = (deps.env.NOMINATIM_BASE_URL || NOMINATIM_DEFAULT_URL).replace(/\/+$/, '');
  let body: unknown;
  try {
    const response = await queue.run(() =>
      deps.http.get(`${baseUrl}/search`, {
        params: {
          q: query,
          format: 'jsonv2',
          countrycodes: 'tr',
          'accept-language': 'tr',
          limit: SEARCH_RESULT_LIMIT,
        },
        headers: { 'User-Agent': NOMINATIM_USER_AGENT },
        timeout: 10_000,
      })
    );
    body = response.data;
  } catch (error) {
    if (error instanceof PlaceSearchError) throw error;
    // The status only: the error's config would carry the query text.
    const status = (error as { response?: { status?: number } }).response?.status;
    console.error(`Nominatim search failed: ${status ?? 'no response'}`);
    throw new PlaceSearchError('upstream');
  }

  const results = parseNominatim(body);
  await deps.cache.set(key, results, SEARCH_CACHE_TTL_SECONDS);
  return results;
}
