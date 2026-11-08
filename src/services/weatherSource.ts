import axios from 'axios';
import cacheService from './cacheService';
import {
  OpenMeteoLimit,
  WeatherHttp,
  WeatherPoint,
  WeatherReading,
  fetchWeatherBatch,
} from './weatherProviders';

/**
 * Every weather read on the server goes through here: regions, saved places
 * and "Konumum". Points are rounded to 0.1 degree and share one cached
 * reading for an hour.
 *
 * Open-Meteo's free limit is 10,000 calls a day per source IP. Render shares
 * the outbound IP with other tenants, so the limit can be used up without us.
 * After a 429 Open-Meteo is left alone until the limit lifts, and our own use
 * stops at 30% of the limit. MET Norway answers in both cases.
 */
export const WEATHER_CACHE_SECONDS = 60 * 60;
export const OPEN_METEO_DAILY_LIMIT = 10_000;
export const OPEN_METEO_DAILY_BUDGET = Math.floor(OPEN_METEO_DAILY_LIMIT * 0.3);
export const WEATHER_BATCH_SIZE = 50;
const USAGE_TTL_SECONDS = 3 * 24 * 60 * 60;
const PAUSE_KEY = 'weather:open-meteo:paused';

export type WeatherCaller = 'regions' | 'places' | 'point';

export interface WeatherStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<boolean>;
  increment(key: string, by: number, ttl: number): Promise<number | null>;
}

export function roundToWeatherGrid(value: number): number {
  return Math.round(value * 10) / 10;
}

export function weatherCellKey(lat: number, lng: number): string {
  return `${roundToWeatherGrid(lat).toFixed(1)}:${roundToWeatherGrid(lng).toFixed(1)}`;
}

function pauseSeconds(limit: OpenMeteoLimit, now: Date): number {
  if (limit === 'minute') return 60;
  if (limit === 'hour') return 60 * 60;
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((midnight - now.getTime()) / 1000));
}

export interface WeatherUsage {
  day: string;
  open_meteo_calls: number;
  open_meteo_limit_share_pct: number;
  open_meteo_429: number;
  met_no_calls: number;
  by_caller: Record<WeatherCaller, number>;
}

export interface WeatherSourceDeps {
  store: WeatherStore;
  http?: WeatherHttp;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export function createWeatherSource(deps: WeatherSourceDeps) {
  const { store } = deps;
  const http = deps.http ?? axios;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((line: string) => console.warn(line));
  // Keeps the guards working for this process when Redis is down.
  let localPausedUntil = 0;
  const localUsage = new Map<string, number>();

  const day = () => now().toISOString().slice(0, 10);
  const usageKey = (name: string) => `weather:usage:${day()}:${name}`;

  async function count(name: string, by: number): Promise<void> {
    if (by <= 0) return;
    const key = usageKey(name);
    localUsage.set(key, (localUsage.get(key) ?? 0) + by);
    await store.increment(key, by, USAGE_TTL_SECONDS);
  }

  async function used(name: string): Promise<number> {
    const key = usageKey(name);
    return Math.max(Number((await store.get<number>(key)) ?? 0), localUsage.get(key) ?? 0);
  }

  async function openMeteoBlocked(): Promise<boolean> {
    if (now().getTime() < localPausedUntil) return true;
    if (await store.get<boolean>(PAUSE_KEY)) return true;
    return (await used('open-meteo')) >= OPEN_METEO_DAILY_BUDGET;
  }

  async function pause(limit: OpenMeteoLimit): Promise<void> {
    const seconds = pauseSeconds(limit, now());
    localPausedUntil = now().getTime() + seconds * 1000;
    await store.set(PAUSE_KEY, true, seconds);
  }

  /** Readings by [weatherCellKey]. A point no provider could answer for is absent. */
  async function readMany(points: readonly WeatherPoint[], caller: WeatherCaller): Promise<Map<string, WeatherReading>> {
    const cells = new Map<string, WeatherPoint>();
    for (const p of points) {
      cells.set(weatherCellKey(p.lat, p.lng), { lat: roundToWeatherGrid(p.lat), lng: roundToWeatherGrid(p.lng) });
    }

    const result = new Map<string, WeatherReading>();
    const missing: [string, WeatherPoint][] = [];
    for (const [key, point] of cells) {
      const cached = await store.get<WeatherReading>(`weather:v2:${key}`);
      if (cached) result.set(key, cached);
      else missing.push([key, point]);
    }

    let skipOpenMeteo = missing.length > 0 && (await openMeteoBlocked());
    for (let i = 0; i < missing.length; i += WEATHER_BATCH_SIZE) {
      const chunk = missing.slice(i, i + WEATHER_BATCH_SIZE);
      const batch = await fetchWeatherBatch(chunk.map(([, point]) => point), http, {
        now: now(),
        sleep: deps.sleep,
        skipOpenMeteo,
      });

      // Each location is counted as one call: Open-Meteo appears to weigh
      // a multi-location request by location, and it is the safe assumption.
      const openMeteoCalls = batch.openMeteoAttempts * chunk.length;
      await count('open-meteo', openMeteoCalls);
      await count(`caller:${caller}`, openMeteoCalls);
      await count('met-no', batch.metCalls);
      if (batch.limit) {
        await count('open-meteo-429', 1);
        await pause(batch.limit);
        skipOpenMeteo = true;
      }
      if (batch.notes.length > 0) log(`Weather (${caller}, ${chunk.length} points): ${batch.notes.join('; ')}`);

      for (const [index, [key]] of chunk.entries()) {
        const reading = batch.readings[index];
        if (!reading) continue;
        const clean: WeatherReading = { ...reading, notes: [] };
        result.set(key, clean);
        await store.set(`weather:v2:${key}`, clean, WEATHER_CACHE_SECONDS);
      }
    }
    return result;
  }

  async function read(lat: number, lng: number, caller: WeatherCaller): Promise<WeatherReading> {
    const reading = (await readMany([{ lat, lng }], caller)).get(weatherCellKey(lat, lng));
    if (!reading) throw new Error('Weather unavailable from every provider');
    return reading;
  }

  async function usage(): Promise<WeatherUsage> {
    const calls = await used('open-meteo');
    return {
      day: day(),
      open_meteo_calls: calls,
      open_meteo_limit_share_pct: Math.round((calls / OPEN_METEO_DAILY_LIMIT) * 1000) / 10,
      open_meteo_429: await used('open-meteo-429'),
      met_no_calls: await used('met-no'),
      by_caller: {
        regions: await used('caller:regions'),
        places: await used('caller:places'),
        point: await used('caller:point'),
      },
    };
  }

  return { readMany, read, usage };
}

export const weatherSource = createWeatherSource({ store: cacheService });
