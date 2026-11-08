"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FWI_HIGH_CLASS = void 0;
exports.nearestFwiClass = nearestFwiClass;
exports.fwiClassFromPng = fwiClassFromPng;
exports.sampleFwiClass = sampleFwiClass;
const axios_1 = __importDefault(require("axios"));
const pngjs_1 = require("pngjs");
/**
 * Reads the Copernicus GWIS Fire Weather Index class at one point, the same
 * way the app does (lib/services/fwi_point_service.dart): the layer is not
 * queryable, so a 3x3 GetMap image is fetched and its centre pixel matched
 * to the six legend colours.
 */
exports.FWI_HIGH_CLASS = 3;
const WMS_URL = 'https://maps.effis.emergency.copernicus.eu/gwis';
/** Index-aligned with the legend: very low ... extreme. */
const PALETTE = [
    [0x9c, 0xff, 0xc0],
    [0xcd, 0xe2, 0x4e],
    [0xe6, 0xac, 0x00],
    [0xd9, 0x70, 0x10],
    [0xad, 0x06, 0x0e],
    [0x3a, 0x00, 0x15],
];
function nearestFwiClass(r, g, b) {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    PALETTE.forEach(([pr, pg, pb], i) => {
        const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
        if (d < bestDistance) {
            bestDistance = d;
            best = i;
        }
    });
    return best;
}
/** The class of the centre pixel; null when it is transparent (no data). */
function fwiClassFromPng(png) {
    const image = pngjs_1.PNG.sync.read(png);
    const offset = (Math.floor(image.height / 2) * image.width + Math.floor(image.width / 2)) * 4;
    if (image.data[offset + 3] === 0)
        return null;
    return nearestFwiClass(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
}
/** Result of one sample: a class, null for "no data". Throws on network failure. */
async function sampleFwiClass(lat, lng, date) {
    const half = 0.03;
    const response = await axios_1.default.get(WMS_URL, {
        params: {
            SERVICE: 'WMS',
            VERSION: '1.1.1',
            REQUEST: 'GetMap',
            LAYERS: 'ecmwf.fwi',
            STYLES: '',
            FORMAT: 'image/png',
            TRANSPARENT: 'true',
            SRS: 'EPSG:4326',
            WIDTH: 3,
            HEIGHT: 3,
            BBOX: [lng - half, lat - half, lng + half, lat + half].map((v) => v.toFixed(4)).join(','),
            TIME: date,
        },
        responseType: 'arraybuffer',
        timeout: 12000,
    });
    return fwiClassFromPng(Buffer.from(response.data));
}
