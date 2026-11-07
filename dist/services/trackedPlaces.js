"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseInstallId = exports.TURKEY_BBOX = exports.PLACES_ANDROID_CHANNEL = exports.HEAT_ALERT_TTL_SECONDS = exports.HEAT_ALERT_CAP_WINDOW_HOURS = exports.HEAT_ALERT_DEVICE_CAP = exports.HEAT_ALERT_MIN_TIERS = exports.HEAT_ALERT_MAX_AGE_HOURS = exports.PLACE_NAME_MAX = exports.PLACE_RADII_KM = exports.MAX_PLACES_PER_DEVICE = void 0;
exports.parseUuid = parseUuid;
exports.parseInstallSecret = parseInstallSecret;
exports.hashInstallSecret = hashInstallSecret;
exports.secretMatches = secretMatches;
exports.parseLocale = parseLocale;
exports.parseFcmToken = parseFcmToken;
exports.normalizePlaceName = normalizePlaceName;
exports.isWithinTurkeyBbox = isWithinTurkeyBbox;
exports.parsePlaceInput = parsePlaceInput;
exports.buildHeatAlertText = buildHeatAlertText;
exports.buildHeatSummaryText = buildHeatSummaryText;
exports.trackedPlacesAvailable = trackedPlacesAvailable;
exports.resetTrackedPlacesCache = resetTrackedPlacesCache;
const crypto_1 = __importDefault(require("crypto"));
const locationPrivacy_1 = require("../utils/locationPrivacy");
/**
 * "Takip ettiğim yerler" (tracked places, app 1.2.0): the pure rules —
 * validation, device credentials, alert wording. The SQL lives in
 * routes/places.ts and jobs/placeAlertJob.ts; the tables in migration 014.
 */
exports.MAX_PLACES_PER_DEVICE = 5;
exports.PLACE_RADII_KM = [5, 10, 25];
exports.PLACE_NAME_MAX = 40;
/** An incident is only alerted while it was seen this recently. */
exports.HEAT_ALERT_MAX_AGE_HOURS = 12;
/** Confidence an incident must have reached before it alerts (decision 3b). */
exports.HEAT_ALERT_MIN_TIERS = ['nominal', 'high'];
/** At most this many heat pushes per device per window. */
exports.HEAT_ALERT_DEVICE_CAP = 3;
exports.HEAT_ALERT_CAP_WINDOW_HOURS = 6;
/** FCM time-to-live: a heat alert older than this is no longer useful. */
exports.HEAT_ALERT_TTL_SECONDS = 6 * 60 * 60;
exports.PLACES_ANDROID_CHANNEL = 'firewatch_places';
/** Same box the report endpoint uses; the precise gate is country_borders. */
exports.TURKEY_BBOX = { minLat: 35.8, maxLat: 42.2, minLng: 25.6, maxLng: 44.8 };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function parseUuid(value) {
    return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}
exports.parseInstallId = parseUuid;
/**
 * The install secret is 32 random bytes, base64url without padding
 * (43 characters). Anything else is rejected rather than hashed, so a weak
 * or truncated secret can never be registered.
 */
function parseInstallSecret(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value))
        return null;
    const bytes = Buffer.from(value, 'base64url');
    return bytes.length === 32 ? bytes : null;
}
function hashInstallSecret(secret) {
    return crypto_1.default.createHash('sha256').update(secret).digest();
}
function secretMatches(secret, storedHash) {
    const hash = hashInstallSecret(secret);
    return storedHash.length === hash.length && crypto_1.default.timingSafeEqual(hash, storedHash);
}
function parseLocale(value) {
    return value === 'tr' || value === 'en' ? value : null;
}
function parseFcmToken(value) {
    return typeof value === 'string' && value.length >= 20 && value.length <= 4096 ? value : null;
}
/**
 * Trims, folds runs of whitespace to one space and drops control and
 * formatting characters (bidi overrides included, since the name ends up in
 * a notification). Null when nothing usable is left or it is too long.
 */
function normalizePlaceName(value) {
    if (typeof value !== 'string')
        return null;
    const cleaned = value
        .replace(/[\p{Cc}\p{Cf}]/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
    if (cleaned.length === 0 || [...cleaned].length > exports.PLACE_NAME_MAX)
        return null;
    return cleaned;
}
function isWithinTurkeyBbox(lat, lng) {
    return lat >= exports.TURKEY_BBOX.minLat && lat <= exports.TURKEY_BBOX.maxLat &&
        lng >= exports.TURKEY_BBOX.minLng && lng <= exports.TURKEY_BBOX.maxLng;
}
/**
 * Validates POST /api/places. Coordinates are rounded here (~1 km), before
 * the border check, so the check is made on exactly what will be stored.
 */
function parsePlaceInput(body) {
    const name = normalizePlaceName(body?.name);
    if (name === null)
        return `name must be 1-${exports.PLACE_NAME_MAX} characters`;
    const rawLat = Number(body?.latitude);
    const rawLng = Number(body?.longitude);
    if (!Number.isFinite(rawLat) || !Number.isFinite(rawLng))
        return 'latitude and longitude are required';
    const latitude = (0, locationPrivacy_1.roundStoredCoordinate)(rawLat);
    const longitude = (0, locationPrivacy_1.roundStoredCoordinate)(rawLng);
    if (!isWithinTurkeyBbox(latitude, longitude))
        return 'outside_turkey';
    const radiusKm = Number(body?.radius_km);
    if (!exports.PLACE_RADII_KM.includes(radiusKm)) {
        return `radius_km must be one of ${exports.PLACE_RADII_KM.join(', ')}`;
    }
    const notify = body?.notify_heat;
    if (notify !== undefined && typeof notify !== 'boolean')
        return 'notify_heat must be a boolean';
    return { name, latitude, longitude, radiusM: radiusKm * 1000, notifyHeat: notify ?? true };
}
function formatKm(distanceM, locale) {
    const km = Math.max(1, Math.round(distanceM / 1000));
    return locale === 'tr' ? `≈${km} km` : `~${km} km`;
}
/**
 * The wording promised in the plan: where, roughly how far, that it is not
 * a confirmed fire, and 112. `extra` is how many more new detections near
 * this device's places this run folded into the same push.
 */
function buildHeatAlertText(locale, placeName, distanceM, extra) {
    const distance = formatKm(distanceM, locale);
    if (locale === 'en') {
        const more = extra > 0 ? ` (+${extra} more detection${extra === 1 ? '' : 's'} near your places)` : '';
        return {
            title: `🛰️ Heat detected near ${placeName}`,
            body: `A satellite detected a heat source ${distance} from "${placeName}"${more}. ` +
                'This is not a confirmed fire. If you see a fire, call 112.',
        };
    }
    const more = extra > 0 ? ` (yerlerinin yakınında +${extra} tespit daha)` : '';
    return {
        title: `🛰️ ${placeName} yakınında ısı tespiti`,
        body: `Uydu, "${placeName}" konumuna ${distance} uzaklıkta bir ısı kaynağı tespit etti${more}. ` +
            'Bu doğrulanmış bir yangın değildir. Yangın görürsen 112\'yi ara.',
    };
}
/**
 * The one push sent when a device's cap window ends with detections held
 * back: how many, same caveats. Tapping it opens the tracked-places list.
 */
function buildHeatSummaryText(locale, count) {
    if (locale === 'en') {
        return {
            title: `🛰️ ${count} new detection${count === 1 ? '' : 's'} near your places`,
            body: `Satellites detected ${count} more heat source${count === 1 ? '' : 's'} near the places you track. ` +
                'These are not confirmed fires. If you see a fire, call 112.',
        };
    }
    return {
        title: `🛰️ Takip ettiğin yerlerin yakınında ${count} yeni tespit`,
        body: `Uydular, takip ettiğin yerlerin yakınında ${count} ısı kaynağı daha tespit etti. ` +
            'Bunlar doğrulanmış yangın değildir. Yangın görürsen 112\'yi ara.',
    };
}
let tablesAvailable = null;
/**
 * Whether migration 014 has been applied. Only a "yes" is memoised, so
 * applying the migration takes effect without a restart.
 */
function trackedPlacesAvailable(pool) {
    if (!tablesAvailable) {
        tablesAvailable = pool
            .query(`SELECT to_regclass('public.place_devices') IS NOT NULL
            AND to_regclass('public.tracked_places') IS NOT NULL
            AND to_regclass('public.place_notifications') IS NOT NULL AS ok`)
            .then((r) => {
            const ok = r.rows[0]?.ok === true;
            if (!ok)
                tablesAvailable = null;
            return ok;
        })
            .catch(() => {
            tablesAvailable = null;
            return false;
        });
    }
    return tablesAvailable;
}
function resetTrackedPlacesCache() {
    tablesAvailable = null;
}
