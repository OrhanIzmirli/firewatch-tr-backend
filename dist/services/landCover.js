"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sampleWorldCover = exports.NATURAL_MIN_SHARE = exports.WOODY_OVERRIDE_SHARE = exports.BUILT_MIN_SHARE = exports.AGRICULTURE_MIN_SHARE = exports.LAND_COVER_RADIUS_M = void 0;
exports.classifyLandCover = classifyLandCover;
exports.worldCoverTileName = worldCoverTileName;
exports.worldCoverUrl = worldCoverUrl;
exports.sharesFromPixels = sharesFromPixels;
exports.naturalOrConfirmedSql = naturalOrConfirmedSql;
const geotiff_1 = require("geotiff");
/** VIIRS pixels are 375 m and a cluster centroid can sit a pixel off. */
exports.LAND_COVER_RADIUS_M = 750;
exports.AGRICULTURE_MIN_SHARE = 35;
exports.BUILT_MIN_SHARE = 30;
exports.WOODY_OVERRIDE_SHARE = 35;
exports.NATURAL_MIN_SHARE = 60;
const CLASS_NAMES = {
    10: 'tree',
    20: 'shrub',
    30: 'grass',
    40: 'crop',
    50: 'built',
    60: 'bare',
    70: 'snow',
    80: 'water',
    90: 'wetland',
    95: 'mangrove',
    100: 'moss',
};
/**
 * Cropland wins a mixed window unless there is real woodland in it: a
 * stubble fire next to a hedge is still a stubble fire, a burn at a forest
 * edge is not. Grass alone is not enough to outvote crops, because
 * WorldCover often maps Anatolian fallow as grass.
 */
function classifyLandCover(s) {
    const share = (k) => s[k] ?? 0;
    const woody = share('tree') + share('shrub');
    const natural = woody + share('grass') + share('wetland') + share('mangrove') + share('moss');
    if (share('built') >= exports.BUILT_MIN_SHARE)
        return 'built';
    if (share('crop') >= exports.AGRICULTURE_MIN_SHARE && woody < exports.WOODY_OVERRIDE_SHARE)
        return 'agriculture';
    if (natural >= exports.NATURAL_MIN_SHARE)
        return 'natural';
    return 'other';
}
function worldCoverTileName(lat, lng) {
    const la = Math.floor(lat / 3) * 3;
    const ln = Math.floor(lng / 3) * 3;
    return `N${String(la).padStart(2, '0')}E${String(ln).padStart(3, '0')}`;
}
function worldCoverUrl(tile) {
    return `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${tile}_Map.tif`;
}
function sharesFromPixels(pixels) {
    const counts = {};
    for (let i = 0; i < pixels.length; i++) {
        const name = CLASS_NAMES[pixels[i]];
        if (name)
            counts[name] = (counts[name] ?? 0) + 1;
    }
    const out = {};
    for (const [k, n] of Object.entries(counts))
        out[k] = Math.round((n / pixels.length) * 100);
    return out;
}
const images = new Map();
function imageFor(lat, lng) {
    const tile = worldCoverTileName(lat, lng);
    let image = images.get(tile);
    if (!image) {
        image = (0, geotiff_1.fromUrl)(worldCoverUrl(tile)).then((tiff) => tiff.getImage());
        images.set(tile, image);
        // A failed open must not be remembered.
        image.catch(() => images.delete(tile));
    }
    return image;
}
/** Throws on network trouble; the caller retries next tick. */
const sampleWorldCover = async (lat, lng) => {
    const image = await imageFor(lat, lng);
    const [originX, originY] = image.getOrigin();
    const [resX, resY] = image.getResolution();
    const dLat = exports.LAND_COVER_RADIUS_M / 111320;
    const dLng = exports.LAND_COVER_RADIUS_M / (111320 * Math.cos((lat * Math.PI) / 180));
    const x0 = Math.max(0, Math.floor((lng - dLng - originX) / resX));
    const x1 = Math.min(image.getWidth(), Math.ceil((lng + dLng - originX) / resX));
    const y0 = Math.max(0, Math.floor((lat + dLat - originY) / resY));
    const y1 = Math.min(image.getHeight(), Math.ceil((lat - dLat - originY) / resY));
    const rasters = await image.readRasters({ window: [x0, y0, x1, y1] });
    return sharesFromPixels(rasters[0]);
};
exports.sampleWorldCover = sampleWorldCover;
/**
 * The SQL form of the rule for the main layer and fire alerts: natural
 * ground or a news-confirmed fire. Not classified yet stays in: a real fire
 * must not vanish because a lookup failed.
 */
function naturalOrConfirmedSql(alias) {
    return `(${alias}.land_cover IS NULL OR ${alias}.land_cover IN ('natural', 'unknown') OR ${alias}.news_verified_id IS NOT NULL)`;
}
