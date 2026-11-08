"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_IMAGE_BYTES = void 0;
exports.thumbUrl = thumbUrl;
exports.pickFullest = pickFullest;
exports.provinceThumb = provinceThumb;
const axios_1 = __importDefault(require("axios"));
const fs_1 = require("fs");
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const newsSources_1 = require("../config/newsSources");
/**
 * Satellite picture of a province on a given day, from NASA GIBS, kept on
 * this server so the app never calls NASA with a reader's IP. MODIS is used
 * because NASA states its CC0 status plainly.
 */
const LAYERS = ['MODIS_Terra_CorrectedReflectance_TrueColor', 'MODIS_Aqua_CorrectedReflectance_TrueColor'];
const WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
/** GIBS answers 200 with an all-black JPEG of about 1 KB when it has no data. */
exports.MIN_IMAGE_BYTES = 8000;
const CACHE_DIR = path_1.default.join(os_1.default.tmpdir(), 'firewatch-news-thumbs');
function thumbUrl(lat, lng, date, layer) {
    const bbox = [lat - 0.65, lng - 1.3, lat + 0.65, lng + 1.3].map((v) => v.toFixed(2)).join(',');
    const q = new URLSearchParams({
        SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: layer, CRS: 'EPSG:4326',
        BBOX: bbox, WIDTH: '640', HEIGHT: '320', FORMAT: 'image/jpeg', TIME: date,
    });
    return `${WMS}?${q}`;
}
/** The fuller of the two images: a swath gap or a blank day compresses to fewer bytes. */
function pickFullest(images) {
    let best = null;
    for (const image of images) {
        if (image && image.length >= exports.MIN_IMAGE_BYTES && (!best || image.length > best.length))
            best = image;
    }
    return best;
}
async function download(url) {
    try {
        const r = await axios_1.default.get(url, { responseType: 'arraybuffer', timeout: 20000, headers: { 'User-Agent': newsSources_1.NEWS_USER_AGENT } });
        return String(r.headers['content-type']).startsWith('image/jpeg') ? Buffer.from(r.data) : null;
    }
    catch {
        return null;
    }
}
const inFlight = new Map();
async function provinceThumb(slug, lat, lng, date) {
    const file = path_1.default.join(CACHE_DIR, `${slug}-${date}.jpg`);
    try {
        return await fs_1.promises.readFile(file);
    }
    catch {
        // not cached yet
    }
    const running = inFlight.get(file);
    if (running)
        return running;
    const job = (async () => {
        const best = pickFullest(await Promise.all(LAYERS.map((l) => download(thumbUrl(lat, lng, date, l)))));
        if (best) {
            await fs_1.promises.mkdir(CACHE_DIR, { recursive: true });
            await fs_1.promises.writeFile(file, best);
        }
        return best;
    })();
    inFlight.set(file, job);
    try {
        return await job;
    }
    finally {
        inFlight.delete(file);
    }
}
