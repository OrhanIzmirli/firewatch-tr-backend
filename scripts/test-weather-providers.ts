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
} from '../src/services/weatherProviders';

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

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
