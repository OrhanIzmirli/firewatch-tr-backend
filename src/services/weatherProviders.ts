import axios from 'axios';

/**
 * Current weather for the risk calculator, with a second provider.
 *
 * Open-Meteo limits free use per source IP, and the backend shares its
 * outbound IP with every other Render tenant on the same host. From
 * 2026-11-03 the 3-hourly risk run got "429 Too Many Requests" for all
 * seven regions at most hours of the day (risk_data got 42, 40, 28 and
 * then 7 rows on 11-03..11-06 instead of 56), so the published risk score
 * stayed hours or a day old. Nothing in our own call volume explains it:
 * seven requests every three hours.
 *
 * Order: Open-Meteo, one retry after a short pause when the failure is a
 * rate limit, server error or network error, then MET Norway's
 * Locationforecast (global coverage, free, identified by User-Agent as
 * their terms require). Both return the same four numbers the score
 * uses. The caller logs which provider answered.
 */

export interface WeatherData {
  temperature: number;
  humidity: number;
  windSpeed: number; // km/h
  windDirection: string;
}

export type WeatherProvider = 'open-meteo' | 'met.no';

export interface WeatherReading {
  weather: WeatherData;
  provider: WeatherProvider;
  /** One line per failed attempt before this answer, for the log. */
  notes: string[];
}

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
export const MET_NORWAY_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
/** MET Norway refuses anonymous clients; the terms ask for an identifying User-Agent. */
export const MET_NORWAY_USER_AGENT =
  'firewatch-tr-backend/1.0 (+https://github.com/OrhanIzmirli/firewatch-tr-backend)';
export const OPEN_METEO_RETRY_DELAY_MS = 3000;
/** A MET forecast step further than this from "now" is not current weather. */
export const MET_MAX_STEP_DISTANCE_MS = 3 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

export function degToDirection(deg: number): string {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round(deg / 45) % 8];
}

function num(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

export function parseOpenMeteo(body: unknown): WeatherData {
  const current = (body as { current?: Record<string, unknown> } | null)?.current;
  if (!current) throw new Error('missing current block');
  return {
    temperature: Math.round(num(current.temperature_2m, 'temperature_2m')),
    humidity: Math.round(num(current.relative_humidity_2m, 'relative_humidity_2m')),
    windSpeed: Math.round(num(current.wind_speed_10m, 'wind_speed_10m')),
    windDirection: degToDirection(typeof current.wind_direction_10m === 'number' ? current.wind_direction_10m : 0),
  };
}

interface MetStep {
  time?: string;
  data?: { instant?: { details?: Record<string, unknown> } };
}

/**
 * MET returns hourly forecast steps; the one nearest to `now` is the
 * current weather. Wind comes in m/s and is converted to km/h to match
 * Open-Meteo's unit.
 */
export function parseMetNorway(body: unknown, now: Date = new Date()): WeatherData {
  const steps = (body as { properties?: { timeseries?: MetStep[] } } | null)?.properties?.timeseries;
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('missing timeseries');

  let best: MetStep | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const step of steps) {
    const t = Date.parse(step.time ?? '');
    if (Number.isNaN(t)) continue;
    const distance = Math.abs(t - now.getTime());
    if (distance < bestDistance) {
      best = step;
      bestDistance = distance;
    }
  }
  if (!best || bestDistance > MET_MAX_STEP_DISTANCE_MS) throw new Error('no step near now');

  const d = best.data?.instant?.details;
  if (!d) throw new Error('missing instant details');
  return {
    temperature: Math.round(num(d.air_temperature, 'air_temperature')),
    humidity: Math.round(num(d.relative_humidity, 'relative_humidity')),
    windSpeed: Math.round(num(d.wind_speed, 'wind_speed') * 3.6),
    windDirection: degToDirection(typeof d.wind_from_direction === 'number' ? d.wind_from_direction : 0),
  };
}

/** The slice of axios the fetch uses, so tests can inject responses. */
export interface WeatherHttp {
  get(url: string, config: {
    params?: Record<string, string | number>;
    headers?: Record<string, string>;
    timeout?: number;
  }): Promise<{ status: number; data: unknown }>;
}

interface HttpFailure {
  response?: { status?: number; data?: unknown };
  code?: string;
  message?: string;
}

/** "HTTP 429 Minutely API request limit exceeded" or the transport error. */
export function describeHttpError(err: unknown): string {
  const e = (err ?? {}) as HttpFailure;
  const status = e.response?.status;
  if (status !== undefined) {
    const data = e.response?.data as { reason?: unknown } | string | undefined;
    const reason =
      typeof data === 'object' && data !== null && typeof data.reason === 'string' ? data.reason
      : typeof data === 'string' ? data.slice(0, 120)
      : '';
    return reason ? `HTTP ${status} ${reason}` : `HTTP ${status}`;
  }
  return e.code ? `${e.code} ${e.message ?? ''}`.trim() : (e.message ?? String(err));
}

/** Worth one more try: rate limit, server error, or no response at all. */
export function isRetryable(err: unknown): boolean {
  const status = ((err ?? {}) as HttpFailure).response?.status;
  return status === undefined || status === 429 || status >= 500;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type OpenMeteoLimit = 'minute' | 'hour' | 'day';

/** Which of Open-Meteo's limits a failure hit, or null when it is not a 429. */
export function openMeteoLimitOf(err: unknown): OpenMeteoLimit | null {
  if (((err ?? {}) as HttpFailure).response?.status !== 429) return null;
  const text = describeHttpError(err).toLowerCase();
  if (text.includes('daily')) return 'day';
  if (text.includes('hourly')) return 'hour';
  return 'minute';
}

/** Open-Meteo answers one object for one location and an array for several. */
export function parseOpenMeteoBatch(body: unknown, count: number): WeatherData[] {
  const list = Array.isArray(body) ? body : [body];
  if (list.length !== count) throw new Error(`expected ${count} locations, got ${list.length}`);
  return list.map(parseOpenMeteo);
}

export interface WeatherPoint {
  lat: number;
  lng: number;
}

export interface WeatherBatch {
  /** Same order as the points. Null when no provider could answer for it. */
  readings: (WeatherReading | null)[];
  notes: string[];
  openMeteoAttempts: number;
  metCalls: number;
  limit: OpenMeteoLimit | null;
}

interface BatchOptions {
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  /** Budget used up or a limit already hit: go straight to MET Norway. */
  skipOpenMeteo?: boolean;
}

/** Open-Meteo for all points in one request, then MET Norway point by point. */
export async function fetchWeatherBatch(
  points: readonly WeatherPoint[],
  http: WeatherHttp = axios,
  options: BatchOptions = {}
): Promise<WeatherBatch> {
  const sleep = options.sleep ?? defaultSleep;
  const notes: string[] = [];
  let openMeteoAttempts = 0;
  let metCalls = 0;
  let limit: OpenMeteoLimit | null = null;

  for (let attempt = 0; attempt < 2 && !options.skipOpenMeteo; attempt++) {
    openMeteoAttempts++;
    try {
      const response = await http.get(OPEN_METEO_URL, {
        params: {
          latitude: points.map((p) => p.lat).join(','),
          longitude: points.map((p) => p.lng).join(','),
          current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m',
          wind_speed_unit: 'kmh',
        },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const weather = parseOpenMeteoBatch(response.data, points.length);
      const readings = weather.map((w): WeatherReading => ({ weather: w, provider: 'open-meteo', notes }));
      return { readings, notes, openMeteoAttempts, metCalls, limit: null };
    } catch (err) {
      notes.push(`open-meteo: ${describeHttpError(err)}`);
      limit = openMeteoLimitOf(err);
      // A daily or hourly limit will not lift in three seconds.
      if (!isRetryable(err) || attempt === 1 || limit === 'day' || limit === 'hour') break;
      await sleep(OPEN_METEO_RETRY_DELAY_MS);
    }
  }

  const readings: (WeatherReading | null)[] = [];
  for (const { lat, lng } of points) {
    metCalls++;
    try {
      const response = await http.get(MET_NORWAY_URL, {
        // MET asks for at most four decimals in coordinates.
        params: { lat: Number(lat.toFixed(4)), lon: Number(lng.toFixed(4)) },
        headers: { 'User-Agent': MET_NORWAY_USER_AGENT, Accept: 'application/json' },
        timeout: REQUEST_TIMEOUT_MS,
      });
      readings.push({ weather: parseMetNorway(response.data, options.now), provider: 'met.no', notes: [...notes] });
    } catch (err) {
      notes.push(`met.no: ${describeHttpError(err)}`);
      readings.push(null);
    }
  }
  return { readings, notes, openMeteoAttempts, metCalls, limit };
}

export async function fetchWeatherWithFallback(
  lat: number,
  lng: number,
  http: WeatherHttp = axios,
  options: { now?: Date; sleep?: (ms: number) => Promise<void> } = {}
): Promise<WeatherReading> {
  const batch = await fetchWeatherBatch([{ lat, lng }], http, options);
  const reading = batch.readings[0];
  if (!reading) throw new Error(`Weather unavailable (${batch.notes.join('; ')})`);
  return reading;
}
