"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PIXEL_HECTARES = exports.MODIS_500M_PIXEL_M = exports.MODIS_SPHERE_RADIUS_M = exports.PRODUCT = void 0;
exports.sinusoidalToLonLat = sinusoidalToLonLat;
exports.lonLatToSinusoidal = lonLatToSinusoidal;
exports.dateFromOrdinalDay = dateFromOrdinalDay;
exports.toIsoDate = toIsoDate;
exports.parseBundleFileName = parseBundleFileName;
exports.extractBurnedPixels = extractBurnedPixels;
exports.hectaresForPixels = hectaresForPixels;
const geotiff_1 = require("geotiff");
/**
 * Pure functions for turning an MCD64A1 GeoTIFF into burned-pixel points.
 * No database, no network: everything here is unit-tested in
 * scripts/test-burned-area.ts against synthetic rasters.
 *
 * MCD64A1 Burn_Date semantics (LP DAAC, product MCD64A1.061):
 *   1..366  ordinal day of the year the pixel burned
 *   0       unburned land
 *   -1      unmapped (insufficient data)
 *   -2      water
 * Only 1..366 is a burn. Everything else is dropped, not counted as zero.
 */
/** Product id as AppEEARS spells it. */
exports.PRODUCT = 'MCD64A1.061';
/**
 * Radius of the sphere the MODIS sinusoidal grid is defined on, metres.
 * From the MODIS Land tile specification; not WGS84's 6378137.
 */
exports.MODIS_SPHERE_RADIUS_M = 6371007.181;
/**
 * Nominal MODIS 500 m pixel edge, metres: 1111950.5197 m tile / 2400 px.
 * The sinusoidal projection is equal-area, so every pixel covers exactly
 * this squared, wherever it is.
 */
exports.MODIS_500M_PIXEL_M = 463.31271653;
/** Ground area of one pixel in hectares: 463.3127² m² / 10 000. */
exports.PIXEL_HECTARES = (exports.MODIS_500M_PIXEL_M * exports.MODIS_500M_PIXEL_M) / 10000;
/**
 * Inverse sinusoidal projection: grid metres → degrees.
 *   y = R·φ            →  φ = y / R
 *   x = R·λ·cos φ      →  λ = x / (R·cos φ)
 */
function sinusoidalToLonLat(x, y) {
    const latRad = y / exports.MODIS_SPHERE_RADIUS_M;
    const cos = Math.cos(latRad);
    if (Math.abs(cos) < 1e-12)
        return { lon: 0, lat: (latRad * 180) / Math.PI };
    const lonRad = x / (exports.MODIS_SPHERE_RADIUS_M * cos);
    return { lon: (lonRad * 180) / Math.PI, lat: (latRad * 180) / Math.PI };
}
/** Forward, for tests and for sanity-checking a raster's origin. */
function lonLatToSinusoidal(lon, lat) {
    const latRad = (lat * Math.PI) / 180;
    const lonRad = (lon * Math.PI) / 180;
    return {
        x: exports.MODIS_SPHERE_RADIUS_M * lonRad * Math.cos(latRad),
        y: exports.MODIS_SPHERE_RADIUS_M * latRad,
    };
}
/** `doy` is 1-based ordinal day; returns the UTC calendar date. */
function dateFromOrdinalDay(year, doy) {
    return new Date(Date.UTC(year, 0, doy));
}
function toIsoDate(d) {
    return d.toISOString().slice(0, 10);
}
/**
 * AppEEARS names area-request rasters
 *   `<PRODUCT>_<LAYER>_doy<YYYYDDD>_aid0001.tif`
 * e.g. `MCD64A1.061_Burn_Date_doy2026182_aid0001.tif` for July 2026.
 * Returns null for anything else (statistics CSVs, lookup tables, QA
 * lookups, XML metadata).
 */
function parseBundleFileName(fileName) {
    const m = /^(.+?)_(Burn_Date|Burn_Date_Uncertainty|QA|First_Day|Last_Day)_doy(\d{4})(\d{3})_aid\d+\.tif$/.exec(fileName);
    if (!m)
        return null;
    const year = Number(m[3]);
    const doy = Number(m[4]);
    const date = dateFromOrdinalDay(year, doy);
    return {
        product: m[1],
        layer: m[2],
        month: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)),
    };
}
async function readSingleBand(buffer) {
    // Copy into a fresh ArrayBuffer: a Node Buffer may be a view on a shared
    // pool, and geotiff wants to own the bytes it parses.
    const bytes = new ArrayBuffer(buffer.byteLength);
    new Uint8Array(bytes).set(buffer);
    const tiff = await (0, geotiff_1.fromArrayBuffer)(bytes);
    const image = await tiff.getImage();
    const [originX, originY] = image.getOrigin();
    const [resX, resY] = image.getResolution();
    const rasters = await image.readRasters();
    const band = rasters[0];
    return {
        width: image.getWidth(),
        height: image.getHeight(),
        data: band,
        grid: { originX, originY, resX, resY },
    };
}
/**
 * Extracts the burned pixels of one monthly Burn_Date raster (optionally
 * paired with its QA raster of identical shape). The raster must be in the
 * native sinusoidal grid: the coordinate transform assumes it, and the
 * hectare constant only holds there.
 */
async function extractBurnedPixels(burnDateTiff, qaTiff, year) {
    const burn = await readSingleBand(burnDateTiff);
    const qa = qaTiff ? await readSingleBand(qaTiff) : null;
    if (qa && (qa.width !== burn.width || qa.height !== burn.height)) {
        throw new Error(`QA raster ${qa.width}x${qa.height} does not match Burn_Date ${burn.width}x${burn.height}`);
    }
    // Guard against a geographic-projection raster slipping through: in
    // sinusoidal metres the pixel edge is ~463 m; in degrees it would be ~0.004.
    if (Math.abs(burn.grid.resX) < 1) {
        throw new Error(`Raster resolution ${burn.grid.resX} looks like degrees, not sinusoidal metres; request projection 'native'`);
    }
    const pixels = [];
    let unexpected = 0;
    const { originX, originY, resX, resY } = burn.grid;
    for (let row = 0; row < burn.height; row++) {
        for (let col = 0; col < burn.width; col++) {
            const value = burn.data[row * burn.width + col];
            if (value >= 1 && value <= 366) {
                const x = originX + (col + 0.5) * resX;
                const y = originY + (row + 0.5) * resY;
                const { lon, lat } = sinusoidalToLonLat(x, y);
                pixels.push({
                    row,
                    col,
                    doy: value,
                    burnDate: dateFromOrdinalDay(year, value),
                    qa: qa ? Number(qa.data[row * burn.width + col]) : null,
                    lon,
                    lat,
                });
            }
            else if (!(value === 0 || value === -1 || value === -2)) {
                // AppEEARS may write its own nodata outside the polygon; count it so
                // a raster full of surprises is visible in the job stats.
                unexpected++;
            }
        }
    }
    return {
        width: burn.width,
        height: burn.height,
        pixelCount: burn.width * burn.height,
        burnedPixelCount: pixels.length,
        unexpectedValueCount: unexpected,
        pixels,
    };
}
/** Hectares for a pixel count, rounded to a hundredth. */
function hectaresForPixels(count) {
    return Math.round(count * exports.PIXEL_HECTARES * 100) / 100;
}
