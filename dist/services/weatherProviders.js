"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MET_MAX_STEP_DISTANCE_MS = exports.OPEN_METEO_RETRY_DELAY_MS = exports.MET_NORWAY_USER_AGENT = exports.MET_NORWAY_URL = exports.OPEN_METEO_URL = void 0;
exports.degToDirection = degToDirection;
exports.parseOpenMeteo = parseOpenMeteo;
exports.parseMetNorway = parseMetNorway;
exports.describeHttpError = describeHttpError;
exports.isRetryable = isRetryable;
exports.fetchWeatherWithFallback = fetchWeatherWithFallback;
const axios_1 = __importDefault(require("axios"));
exports.OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
exports.MET_NORWAY_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
/** MET Norway refuses anonymous clients; the terms ask for an identifying User-Agent. */
exports.MET_NORWAY_USER_AGENT = 'firewatch-tr-backend/1.0 (+https://github.com/OrhanIzmirli/firewatch-tr-backend)';
exports.OPEN_METEO_RETRY_DELAY_MS = 3000;
/** A MET forecast step further than this from "now" is not current weather. */
exports.MET_MAX_STEP_DISTANCE_MS = 3 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
function degToDirection(deg) {
    const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return directions[Math.round(deg / 45) % 8];
}
function num(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`missing ${name}`);
    }
    return value;
}
function parseOpenMeteo(body) {
    const current = body?.current;
    if (!current)
        throw new Error('missing current block');
    return {
        temperature: Math.round(num(current.temperature_2m, 'temperature_2m')),
        humidity: Math.round(num(current.relative_humidity_2m, 'relative_humidity_2m')),
        windSpeed: Math.round(num(current.wind_speed_10m, 'wind_speed_10m')),
        windDirection: degToDirection(typeof current.wind_direction_10m === 'number' ? current.wind_direction_10m : 0),
    };
}
/**
 * MET returns hourly forecast steps; the one nearest to `now` is the
 * current weather. Wind comes in m/s and is converted to km/h to match
 * Open-Meteo's unit.
 */
function parseMetNorway(body, now = new Date()) {
    const steps = body?.properties?.timeseries;
    if (!Array.isArray(steps) || steps.length === 0)
        throw new Error('missing timeseries');
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const step of steps) {
        const t = Date.parse(step.time ?? '');
        if (Number.isNaN(t))
            continue;
        const distance = Math.abs(t - now.getTime());
        if (distance < bestDistance) {
            best = step;
            bestDistance = distance;
        }
    }
    if (!best || bestDistance > exports.MET_MAX_STEP_DISTANCE_MS)
        throw new Error('no step near now');
    const d = best.data?.instant?.details;
    if (!d)
        throw new Error('missing instant details');
    return {
        temperature: Math.round(num(d.air_temperature, 'air_temperature')),
        humidity: Math.round(num(d.relative_humidity, 'relative_humidity')),
        windSpeed: Math.round(num(d.wind_speed, 'wind_speed') * 3.6),
        windDirection: degToDirection(typeof d.wind_from_direction === 'number' ? d.wind_from_direction : 0),
    };
}
/** "HTTP 429 Minutely API request limit exceeded" or the transport error. */
function describeHttpError(err) {
    const e = (err ?? {});
    const status = e.response?.status;
    if (status !== undefined) {
        const data = e.response?.data;
        const reason = typeof data === 'object' && data !== null && typeof data.reason === 'string' ? data.reason
            : typeof data === 'string' ? data.slice(0, 120)
                : '';
        return reason ? `HTTP ${status} ${reason}` : `HTTP ${status}`;
    }
    return e.code ? `${e.code} ${e.message ?? ''}`.trim() : (e.message ?? String(err));
}
/** Worth one more try: rate limit, server error, or no response at all. */
function isRetryable(err) {
    const status = (err ?? {}).response?.status;
    return status === undefined || status === 429 || status >= 500;
}
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fetchWeatherWithFallback(lat, lng, http = axios_1.default, options = {}) {
    const sleep = options.sleep ?? defaultSleep;
    const notes = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const response = await http.get(exports.OPEN_METEO_URL, {
                params: {
                    latitude: lat,
                    longitude: lng,
                    current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m',
                    wind_speed_unit: 'kmh',
                },
                timeout: REQUEST_TIMEOUT_MS,
            });
            return { weather: parseOpenMeteo(response.data), provider: 'open-meteo', notes };
        }
        catch (err) {
            notes.push(`open-meteo: ${describeHttpError(err)}`);
            if (!isRetryable(err) || attempt === 1)
                break;
            await sleep(exports.OPEN_METEO_RETRY_DELAY_MS);
        }
    }
    try {
        const response = await http.get(exports.MET_NORWAY_URL, {
            // MET asks for at most four decimals in coordinates.
            params: { lat: Number(lat.toFixed(4)), lon: Number(lng.toFixed(4)) },
            headers: { 'User-Agent': exports.MET_NORWAY_USER_AGENT, Accept: 'application/json' },
            timeout: REQUEST_TIMEOUT_MS,
        });
        return { weather: parseMetNorway(response.data, options.now), provider: 'met.no', notes };
    }
    catch (err) {
        notes.push(`met.no: ${describeHttpError(err)}`);
    }
    throw new Error(`Weather unavailable (${notes.join('; ')})`);
}
