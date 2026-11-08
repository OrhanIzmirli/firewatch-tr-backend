/**
 * Unit test for services/weatherProviders.ts: Open-Meteo parsing, MET
 * Norway parsing, and the fallback order the risk calculator relies on.
 *
 *   npm run test:weather-providers
 *
 * No network: the http client is a stub that answers from the fixtures
 * below (Open-Meteo and MET bodies copied from live responses, 2026-11-06).
 */
import assert from 'node:assert';
import {
  MET_NORWAY_URL,
  MET_NORWAY_USER_AGENT,
  OPEN_METEO_URL,
  OPEN_METEO_RETRY_DELAY_MS,
  WeatherHttp,
  degToDirection,
  describeHttpError,
  fetchWeatherWithFallback,
  isRetryable,
  parseMetNorway,
  parseOpenMeteo,
  fetchWeatherBatch,
  openMeteoLimitOf,
  parseOpenMeteoBatch,
} from '../src/services/weatherProviders';
import {
  OPEN_METEO_DAILY_BUDGET,
  WEATHER_CACHE_SECONDS,
  WeatherStore,
  createWeatherSource,
  weatherCellKey,
} from '../src/services/weatherSource';
import { markStaleRisk } from '../src/services/riskScore';

let failures = 0;
const t = async (name: string, fn: () => void | Promise<void>) => {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

const OPEN_METEO_BODY = {
  latitude: 38.432575, longitude: 27.208298,
  current_units: { temperature_2m: '°C', relative_humidity_2m: '%', wind_speed_10m: 'km/h', wind_direction_10m: '°' },
  current: { time: '2026-11-06T21:45', interval: 900, temperature_2m: 12.4, relative_humidity_2m: 71, wind_speed_10m: 9.7, wind_direction_10m: 320 },
};

const NOW = new Date('2026-11-06T21:50:00Z');
const MET_BODY = {
  type: 'Feature',
  properties: {
    meta: { units: { air_temperature: 'celsius', relative_humidity: '%', wind_from_direction: 'degrees', wind_speed: 'm/s' } },
    timeseries: [
      { time: '2026-11-06T21:00:00Z', data: { instant: { details: { air_temperature: 9.5, relative_humidity: 78.0, wind_from_direction: 321.1, wind_speed: 3.7 } } } },
      { time: '2026-11-06T22:00:00Z', data: { instant: { details: { air_temperature: 9.0, relative_humidity: 80.0, wind_from_direction: 300.0, wind_speed: 2.0 } } } },
      { time: '2026-11-06T23:00:00Z', data: { instant: { details: { air_temperature: 8.5, relative_humidity: 82.0, wind_from_direction: 290.0, wind_speed: 1.0 } } } },
    ],
  },
};

const http429 = { response: { status: 429, data: { error: true, reason: 'Minutely API request limit exceeded. Please try again in one minute.' } }, message: 'Request failed with status code 429' };
const httpTimeout = { code: 'ECONNABORTED', message: 'timeout of 10000ms exceeded' };
const http400 = { response: { status: 400, data: { error: true, reason: 'Latitude must be in range of -90 to 90.' } }, message: 'Request failed with status code 400' };

interface Call { url: string; config: Parameters<WeatherHttp['get']>[1] }
/** Answers each URL from a queue: a body (object) or an error to throw. */
function stub(script: Record<string, unknown[]>) {
  const calls: Call[] = [];
  const http: WeatherHttp = {
    async get(url, config) {
      calls.push({ url, config });
      const queue = script[url] ?? [];
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected call to ${url}`);
      if (typeof next === 'object' && next !== null && ('response' in next || 'code' in next)) throw next;
      return { status: 200, data: next };
    },
  };
  return { http, calls };
}
const noSleep = { now: NOW, sleep: async () => undefined };

(async () => {
  await t('Open-Meteo body parses and rounds', () => {
    assert.deepStrictEqual(parseOpenMeteo(OPEN_METEO_BODY), { temperature: 12, humidity: 71, windSpeed: 10, windDirection: 'NW' });
  });
  await t('Open-Meteo body without current block is rejected', () => {
    assert.throws(() => parseOpenMeteo({}), /missing current/);
    assert.throws(() => parseOpenMeteo({ current: { temperature_2m: 'x' } }), /temperature_2m/);
  });
  await t('MET body: nearest step to now, wind m/s converted to km/h', () => {
    // 21:50 is nearer to 22:00 than to 21:00
    assert.deepStrictEqual(parseMetNorway(MET_BODY, NOW), { temperature: 9, humidity: 80, windSpeed: 7, windDirection: 'NW' });
    assert.deepStrictEqual(parseMetNorway(MET_BODY, new Date('2026-11-06T21:10:00Z')).windSpeed, 13);
  });
  await t('MET body with no step within three hours is rejected', () => {
    assert.throws(() => parseMetNorway(MET_BODY, new Date('2026-11-07T12:00:00Z')), /no step near now/);
    assert.throws(() => parseMetNorway({ properties: { timeseries: [] } }, NOW), /missing timeseries/);
  });
  await t('compass direction from degrees', () => {
    assert.strictEqual(degToDirection(0), 'N');
    assert.strictEqual(degToDirection(321), 'NW');
    assert.strictEqual(degToDirection(359), 'N');
    assert.strictEqual(degToDirection(180), 'S');
  });
  await t('errors are described with status and provider reason', () => {
    assert.strictEqual(describeHttpError(http429), 'HTTP 429 Minutely API request limit exceeded. Please try again in one minute.');
    assert.strictEqual(describeHttpError(httpTimeout), 'ECONNABORTED timeout of 10000ms exceeded');
    assert.strictEqual(describeHttpError({ response: { status: 503 } }), 'HTTP 503');
  });
  await t('429, 5xx and network errors are retryable; 400 is not', () => {
    assert.ok(isRetryable(http429));
    assert.ok(isRetryable({ response: { status: 502 } }));
    assert.ok(isRetryable(httpTimeout));
    assert.ok(!isRetryable(http400));
  });

  await t('Open-Meteo answers first time: no notes, MET not called', async () => {
    const { http, calls } = stub({ [OPEN_METEO_URL]: [OPEN_METEO_BODY] });
    const r = await fetchWeatherWithFallback(38.42, 27.14, http, noSleep);
    assert.strictEqual(r.provider, 'open-meteo');
    assert.deepStrictEqual(r.notes, []);
    assert.strictEqual(r.weather.temperature, 12);
    assert.deepStrictEqual(calls.map((c) => c.url), [OPEN_METEO_URL]);
    assert.strictEqual(calls[0].config.params?.wind_speed_unit, 'kmh');
  });
  await t('Open-Meteo 429 then success on the retry', async () => {
    const { http, calls } = stub({ [OPEN_METEO_URL]: [http429, OPEN_METEO_BODY] });
    const slept: number[] = [];
    const r = await fetchWeatherWithFallback(38.42, 27.14, http, { now: NOW, sleep: async (ms) => { slept.push(ms); } });
    assert.strictEqual(r.provider, 'open-meteo');
    assert.deepStrictEqual(slept, [OPEN_METEO_RETRY_DELAY_MS]);
    assert.deepStrictEqual(r.notes, ['open-meteo: HTTP 429 Minutely API request limit exceeded. Please try again in one minute.']);
    assert.strictEqual(calls.length, 2);
  });
  await t('Open-Meteo 429 twice: MET Norway answers, identified by User-Agent', async () => {
    const { http, calls } = stub({ [OPEN_METEO_URL]: [http429, http429], [MET_NORWAY_URL]: [MET_BODY] });
    const r = await fetchWeatherWithFallback(38.42, 27.14, http, noSleep);
    assert.strictEqual(r.provider, 'met.no');
    assert.deepStrictEqual(r.weather, { temperature: 9, humidity: 80, windSpeed: 7, windDirection: 'NW' });
    assert.strictEqual(r.notes.length, 2);
    const met = calls[2];
    assert.strictEqual(met.url, MET_NORWAY_URL);
    assert.strictEqual(met.config.headers?.['User-Agent'], MET_NORWAY_USER_AGENT);
    assert.deepStrictEqual(met.config.params, { lat: 38.42, lon: 27.14 });
  });
  await t('MET coordinates are limited to four decimals', async () => {
    const { http, calls } = stub({ [OPEN_METEO_URL]: [http400], [MET_NORWAY_URL]: [MET_BODY] });
    await fetchWeatherWithFallback(38.123456, 27.987654, http, noSleep);
    assert.deepStrictEqual(calls[1].config.params, { lat: 38.1235, lon: 27.9877 });
  });
  await t('a non-retryable Open-Meteo error goes straight to MET', async () => {
    const { http, calls } = stub({ [OPEN_METEO_URL]: [http400], [MET_NORWAY_URL]: [MET_BODY] });
    const r = await fetchWeatherWithFallback(38.42, 27.14, http, noSleep);
    assert.strictEqual(r.provider, 'met.no');
    assert.deepStrictEqual(calls.map((c) => c.url), [OPEN_METEO_URL, MET_NORWAY_URL]);
  });
  await t('both providers down: one error naming every attempt', async () => {
    const { http } = stub({ [OPEN_METEO_URL]: [http429, httpTimeout], [MET_NORWAY_URL]: [{ response: { status: 503 } }] });
    await assert.rejects(
      () => fetchWeatherWithFallback(38.42, 27.14, http, noSleep),
      /Weather unavailable \(open-meteo: HTTP 429 Minutely.*; open-meteo: ECONNABORTED timeout of 10000ms exceeded; met.no: HTTP 503\)/
    );
  });
  await t('an unparseable MET body counts as a MET failure', async () => {
    const { http } = stub({ [OPEN_METEO_URL]: [http429, http429], [MET_NORWAY_URL]: [{ properties: {} }] });
    await assert.rejects(() => fetchWeatherWithFallback(38.42, 27.14, http, noSleep), /met.no: missing timeseries/);
  });

  const httpDaily = { response: { status: 429, data: { error: true, reason: 'Daily API request limit exceeded. Please try again tomorrow.' } }, message: 'Request failed with status code 429' };
  const memoryStore = () => {
    const values = new Map<string, unknown>();
    const ttls = new Map<string, number | undefined>();
    const store: WeatherStore = {
      async get<T>(key: string) { return (values.has(key) ? values.get(key) : null) as T | null; },
      async set<T>(key: string, value: T, ttl?: number) { values.set(key, value); ttls.set(key, ttl); return true; },
      async increment(key, by) { const total = Number(values.get(key) ?? 0) + by; values.set(key, total); return total; },
    };
    return { store, values, ttls };
  };
  const source = (http: WeatherHttp, store: WeatherStore) =>
    createWeatherSource({ store, http, now: () => NOW, sleep: async () => undefined, log: () => undefined });
  const openMeteoFor = (n: number) => Array.from({ length: n }, () => OPEN_METEO_BODY);
  const SEVEN = [[38.42, 27.14], [36.9, 30.7], [40.18, 29.07], [41.28, 36.33], [39.93, 32.86], [39.9, 41.27], [37.07, 37.38]].map(([lat, lng]) => ({ lat, lng }));

  await t('several points go in one Open-Meteo request', async () => {
    const { http, calls } = stub({ [OPEN_METEO_URL]: [openMeteoFor(2)] });
    const b = await fetchWeatherBatch([{ lat: 38.4, lng: 27.1 }, { lat: 36.9, lng: 30.7 }], http, noSleep);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].config.params?.latitude, '38.4,36.9');
    assert.strictEqual(calls[0].config.params?.longitude, '27.1,30.7');
    assert.ok(b.readings.every((r) => r?.provider === 'open-meteo'));
  });
  await t('a batch answer with the wrong number of locations is rejected', () => {
    assert.throws(() => parseOpenMeteoBatch(openMeteoFor(1), 2), /expected 2 locations/);
  });
  await t('the kind of 429 is read from the reason', () => {
    assert.strictEqual(openMeteoLimitOf(httpDaily), 'day');
    assert.strictEqual(openMeteoLimitOf({ response: { status: 429, data: { reason: 'Hourly API request limit exceeded.' } } }), 'hour');
    assert.strictEqual(openMeteoLimitOf(http429), 'minute');
    assert.strictEqual(openMeteoLimitOf(http400), null);
  });
  await t('a daily 429 is not retried and MET answers', async () => {
    const { http, calls } = stub({ [OPEN_METEO_URL]: [httpDaily], [MET_NORWAY_URL]: [MET_BODY] });
    const r = await fetchWeatherWithFallback(38.42, 27.14, http, noSleep);
    assert.strictEqual(r.provider, 'met.no');
    assert.deepStrictEqual(calls.map((c) => c.url), [OPEN_METEO_URL, MET_NORWAY_URL]);
  });
  await t('seven regions cost one HTTP request', async () => {
    const { http, calls } = stub({ [OPEN_METEO_URL]: [openMeteoFor(7)] });
    const r = await source(http, memoryStore().store).readMany(SEVEN, 'regions');
    assert.strictEqual(r.size, 7);
    assert.strictEqual(calls.length, 1);
  });
  await t('points in the same 0.1 degree cell share one reading for an hour', async () => {
    const m = memoryStore();
    const { http, calls } = stub({ [OPEN_METEO_URL]: [OPEN_METEO_BODY] });
    const s = source(http, m.store);
    await s.read(38.41, 27.14, 'point');
    await s.read(38.44, 27.12, 'places');
    assert.strictEqual(calls.length, 1, 'the second caller used the cache');
    assert.strictEqual(calls[0].config.params?.latitude, '38.4');
    assert.strictEqual(m.ttls.get(`weather:v2:${weatherCellKey(38.41, 27.14)}`), WEATHER_CACHE_SECONDS);
  });
  await t('a restart reads the shared cache instead of calling again', async () => {
    const m = memoryStore();
    const first = stub({ [OPEN_METEO_URL]: [openMeteoFor(7)] });
    await source(first.http, m.store).readMany(SEVEN, 'regions');
    const second = stub({});
    const r = await source(second.http, m.store).readMany(SEVEN, 'regions');
    assert.strictEqual(r.size, 7);
    assert.strictEqual(second.calls.length, 0);
  });
  await t('forced 429: MET Norway answers and Open-Meteo is left alone afterwards', async () => {
    const m = memoryStore();
    const { http, calls } = stub({ [OPEN_METEO_URL]: [httpDaily], [MET_NORWAY_URL]: [MET_BODY, MET_BODY] });
    const s = source(http, m.store);
    const first = await s.read(38.4, 27.1, 'regions');
    assert.strictEqual(first.provider, 'met.no');
    assert.deepStrictEqual(first.weather, { temperature: 9, humidity: 80, windSpeed: 7, windDirection: 'NW' });
    const second = await s.read(36.9, 30.7, 'point');
    assert.strictEqual(second.provider, 'met.no');
    assert.strictEqual(calls.filter((c) => c.url === OPEN_METEO_URL).length, 1);
    assert.strictEqual((await s.usage()).open_meteo_429, 1);
  });
  await t('the daily budget stops Open-Meteo at 30% of its limit', async () => {
    const m = memoryStore();
    assert.strictEqual(OPEN_METEO_DAILY_BUDGET, 3000);
    await m.store.increment('weather:usage:2026-11-06:open-meteo', OPEN_METEO_DAILY_BUDGET, 1);
    const { http, calls } = stub({ [MET_NORWAY_URL]: [MET_BODY] });
    const r = await source(http, m.store).read(38.4, 27.1, 'point');
    assert.strictEqual(r.provider, 'met.no');
    assert.deepStrictEqual(calls.map((c) => c.url), [MET_NORWAY_URL]);
  });
  await t('usage is counted per location and per caller', async () => {
    const { http } = stub({ [OPEN_METEO_URL]: [openMeteoFor(7)] });
    const s = source(http, memoryStore().store);
    await s.readMany(SEVEN, 'regions');
    const u = await s.usage();
    assert.strictEqual(u.open_meteo_calls, 7);
    assert.strictEqual(u.by_caller.regions, 7);
    assert.strictEqual(u.open_meteo_limit_share_pct, 0.1);
  });
  await t('both providers down: no reading, nothing cached, nothing invented', async () => {
    const m = memoryStore();
    const { http } = stub({ [OPEN_METEO_URL]: [httpDaily], [MET_NORWAY_URL]: [{ response: { status: 503 } }, { response: { status: 503 } }, { response: { status: 503 } }] });
    const s = source(http, m.store);
    const r = await s.readMany([{ lat: 38.4, lng: 27.1 }, { lat: 36.9, lng: 30.7 }], 'regions');
    assert.strictEqual(r.size, 0);
    assert.ok(![...m.values.keys()].some((k) => k.startsWith('weather:v2:')));
    await assert.rejects(() => s.read(38.4, 27.1, 'point'), /unavailable/);
  });
  await t('one point failing at MET does not lose the others', async () => {
    const { http } = stub({ [OPEN_METEO_URL]: [httpDaily], [MET_NORWAY_URL]: [{ response: { status: 503 } }, MET_BODY] });
    const r = await source(http, memoryStore().store).readMany([{ lat: 38.4, lng: 27.1 }, { lat: 36.9, lng: 30.7 }], 'regions');
    assert.deepStrictEqual([...r.keys()], [weatherCellKey(36.9, 30.7)]);
  });
  await t('a score older than two runs is marked stale', () => {
    const at = (hours: number) => new Date(NOW.getTime() - hours * 3600_000).toISOString();
    const rows = markStaleRisk([{ created_at: at(5.9) }, { created_at: at(6.1) }, { created_at: 'x' }], NOW);
    assert.deepStrictEqual(rows.map((r) => r.is_stale), [false, true, true]);
  });

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
