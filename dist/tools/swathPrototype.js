"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable no-console */
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const axios_1 = __importDefault(require("axios"));
const swathGeometry_1 = require("../services/swathGeometry");
/**
 * Prototype and validation for orbit-derived coverage.
 *
 * Writes nothing to any database and touches no endpoint.
 *
 *   NASA_API_KEY=... npx ts-node src/tools/swathPrototype.ts
 *
 * Validation is free and decisive: every FIRMS detection is a location that
 * was definitely scanned at that instant, so the share of detections the
 * computed swath covers measures the geometry directly. Anything much under
 * 100% means the geometry is wrong and integration must not proceed.
 */
const TLE_CACHE_DIR = path_1.default.join(process.cwd(), '.tle-cache');
const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';
const FIRMS_BASE = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const FIRMS_AREA = '25,35,45,43';
const FIRMS_DAYS = Number(process.env.FIRMS_DAYS ?? 1);
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS ?? 24);
const STEP_SECONDS = 30;
async function loadTle(sensor) {
    if (!fs_1.default.existsSync(TLE_CACHE_DIR))
        fs_1.default.mkdirSync(TLE_CACHE_DIR, { recursive: true });
    const file = path_1.default.join(TLE_CACHE_DIR, `${sensor.tleName.replace(/[^\w]/g, '_')}.tle`);
    if (fs_1.default.existsSync(file)) {
        const ageHours = (Date.now() - fs_1.default.statSync(file).mtimeMs) / 3600000;
        if (ageHours < 12)
            return fs_1.default.readFileSync(file, 'utf8');
    }
    const response = await axios_1.default.get(CELESTRAK, {
        params: { NAME: sensor.tleName.split(' (')[0], FORMAT: 'TLE' },
        timeout: 30000,
        responseType: 'text',
    });
    fs_1.default.writeFileSync(file, response.data, 'utf8');
    return response.data;
}
function parseCsv(csv, product) {
    const lines = csv.trim().split(/\r?\n/);
    if (lines.length <= 1)
        return [];
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const at = (name) => header.indexOf(name);
    const out = [];
    for (let i = 1; i < lines.length; i++) {
        const c = lines[i].split(',');
        const lat = Number(c[at('latitude')]);
        const lon = Number(c[at('longitude')]);
        const date = c[at('acq_date')]?.trim();
        const raw = Number.parseInt(c[at('acq_time')]?.trim() ?? '', 10);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || !date || !Number.isFinite(raw))
            continue;
        const [y, m, d] = date.split('-').map(Number);
        out.push({
            lat, lon,
            time: new Date(Date.UTC(y, m - 1, d, Math.floor(raw / 100), raw % 100)),
            satelliteCode: (c[at('satellite')] ?? '').trim(),
            product,
        });
    }
    return out;
}
/** Contiguous windows where the sub-satellite point could reach Turkey. */
function turkeyWindows(track, sensor) {
    const BOX = { minLat: 35.8, maxLat: 42.2, minLng: 25.6, maxLng: 44.8 };
    const windows = [];
    let current = [];
    let lastIdx = -2;
    track.forEach((p, i) => {
        const half = (0, swathGeometry_1.halfSwathKm)(p.altKm, sensor.scanAngleDeg);
        const clampedLat = Math.min(BOX.maxLat, Math.max(BOX.minLat, p.latDeg));
        const clampedLon = Math.min(BOX.maxLng, Math.max(BOX.minLng, p.lonDeg));
        if ((0, swathGeometry_1.distanceKm)(p.latDeg, p.lonDeg, clampedLat, clampedLon) > half * 1.05)
            return;
        if (i !== lastIdx + 1 && current.length) {
            windows.push(current);
            current = [];
        }
        current.push(p);
        lastIdx = i;
    });
    if (current.length)
        windows.push(current);
    return windows.filter((w) => w.length >= 2);
}
function fmt(d) { return d.toISOString().slice(11, 16); }
async function main() {
    const apiKey = process.env.NASA_API_KEY;
    const end = new Date();
    const start = new Date(end.getTime() - WINDOW_HOURS * 3600000);
    const memStart = process.memoryUsage().heapUsed;
    const wallStart = Date.now();
    console.log(`window  ${start.toISOString()} .. ${end.toISOString()}`);
    console.log(`step    ${STEP_SECONDS}s   nadir limit ${swathGeometry_1.NADIR_FRACTION_LIMIT}\n`);
    // ---- 1. orbits -----------------------------------------------------------
    const tracks = new Map();
    const windowsBySensor = new Map();
    let propagateMs = 0;
    for (const sensor of swathGeometry_1.SENSORS) {
        let tle;
        try {
            tle = await loadTle(sensor);
        }
        catch (e) {
            console.log(`${sensor.name.padEnd(11)} TLE FETCH FAILED ${e.message}`);
            continue;
        }
        const satrec = (0, swathGeometry_1.parseTle)(tle, sensor.tleName);
        if (!satrec) {
            console.log(`${sensor.name.padEnd(11)} TLE PARSE FAILED`);
            continue;
        }
        const t0 = Date.now();
        const track = (0, swathGeometry_1.groundTrack)(satrec, start, end, STEP_SECONDS);
        propagateMs += Date.now() - t0;
        tracks.set(sensor.name, track);
        const windows = turkeyWindows(track, sensor);
        windowsBySensor.set(sensor.name, windows);
        console.log(`${sensor.name.padEnd(11)} passes over Turkey=${String(windows.length).padStart(2)}  ` +
            `half-swath=${(0, swathGeometry_1.halfSwathKm)(track[0]?.altKm ?? 830, sensor.scanAngleDeg).toFixed(0)}km  ` +
            `[${windows.map((w) => `${fmt(w[0].time)}-${fmt(w[w.length - 1].time)}`).join(' ')}]`);
    }
    const totalPasses = [...windowsBySensor.values()].reduce((s, w) => s + w.length, 0);
    console.log(`\nCOMPUTED PASSES OVER TURKEY IN ${WINDOW_HOURS}h: ${totalPasses}`);
    if (!apiKey) {
        console.log('\nNASA_API_KEY not set — skipping validation');
        return;
    }
    // ---- 2. real detections --------------------------------------------------
    const detections = [];
    const perProduct = new Map();
    for (const product of ['VIIRS_SNPP_NRT', 'VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT']) {
        try {
            const url = `${FIRMS_BASE}/${encodeURIComponent(apiKey)}/${product}/${FIRMS_AREA}/${FIRMS_DAYS}`;
            const { data } = await axios_1.default.get(url, { timeout: 30000, responseType: 'text' });
            const rows = parseCsv(data, product);
            detections.push(...rows);
            perProduct.set(product, rows.length);
        }
        catch (e) {
            console.log(`  ${product} fetch failed: ${e.message}`);
        }
    }
    console.log('\nFIRMS rows:', Object.fromEntries(perProduct), 'total', detections.length);
    // ---- 3. how many computed passes actually produced detections? -----------
    console.log('\n--- passes with vs without detections (this is what TLE adds) ---');
    let silent = 0, productive = 0;
    for (const sensor of swathGeometry_1.SENSORS) {
        const windows = windowsBySensor.get(sensor.name) ?? [];
        for (const w of windows) {
            const from = w[0].time.getTime() - 300000;
            const to = w[w.length - 1].time.getTime() + 300000;
            const hits = detections.filter((d) => sensor.firmsSatelliteCodes.includes(d.satelliteCode) &&
                d.time.getTime() >= from && d.time.getTime() <= to).length;
            if (hits === 0)
                silent++;
            else
                productive++;
            console.log(`  ${sensor.name.padEnd(11)} ${fmt(w[0].time)}-${fmt(w[w.length - 1].time)}  ` +
                `detections=${String(hits).padStart(4)}  ${hits === 0 ? 'SILENT (invisible to the old method)' : ''}`);
        }
    }
    console.log(`\n  passes that produced detections : ${productive}`);
    console.log(`  passes that produced NOTHING     : ${silent}   <- only TLE can see these`);
    // ---- 4. validation: known detections must be inside their own swath ------
    console.log('\n--- VALIDATION ---');
    let checked = 0, covered = 0, nadir = 0, edge = 0, noWindow = 0;
    const missBySensor = new Map();
    const fractions = [];
    for (const d of detections) {
        const sensor = swathGeometry_1.SENSORS.find((s) => s.firmsSatelliteCodes.includes(d.satelliteCode));
        if (!sensor)
            continue;
        const windows = windowsBySensor.get(sensor.name) ?? [];
        const w = windows.find((win) => d.time.getTime() >= win[0].time.getTime() - 300000 &&
            d.time.getTime() <= win[win.length - 1].time.getTime() + 300000);
        if (!w) {
            noWindow++;
            continue;
        }
        checked++;
        const result = (0, swathGeometry_1.coverageForPoint)(w, d.lat, d.lon, sensor.scanAngleDeg);
        if (result.covered) {
            covered++;
            fractions.push(result.fraction);
            if (result.nearNadir)
                nadir++;
            else
                edge++;
        }
        else {
            missBySensor.set(sensor.name, (missBySensor.get(sensor.name) ?? 0) + 1);
        }
    }
    const pct = checked ? (100 * covered) / checked : 0;
    console.log(`  detections matched to a computed pass : ${checked}`);
    console.log(`  detections with no computed pass      : ${noWindow}`);
    console.log(`  INSIDE computed swath                 : ${covered}  (${pct.toFixed(2)}%)`);
    if (missBySensor.size)
        console.log('  misses by sensor:', Object.fromEntries(missBySensor));
    if (fractions.length) {
        console.log(`\n  near-nadir (<=${swathGeometry_1.NADIR_FRACTION_LIMIT}) : ${nadir}  (${((100 * nadir) / fractions.length).toFixed(1)}%)  strong evidence`);
        console.log(`  scan edge  (>${swathGeometry_1.NADIR_FRACTION_LIMIT})  : ${edge}  (${((100 * edge) / fractions.length).toFixed(1)}%)  weak evidence`);
        fractions.sort((a, b) => a - b);
        const bucket = [0, 0, 0, 0, 0];
        for (const f of fractions)
            bucket[Math.min(4, Math.floor(f * 5))]++;
        console.log('\n  across-track distribution (0 = nadir, 1 = edge):');
        ['0.0-0.2', '0.2-0.4', '0.4-0.6', '0.6-0.8', '0.8-1.0'].forEach((label, i) => {
            const share = (100 * bucket[i]) / fractions.length;
            console.log(`    ${label}  ${String(bucket[i]).padStart(5)}  ${share.toFixed(1).padStart(5)}%  ${'#'.repeat(Math.round(share / 2))}`);
        });
        console.log(`    median fraction: ${fractions[Math.floor(fractions.length / 2)].toFixed(3)}`);
    }
    // ---- 5. cost -------------------------------------------------------------
    const memPeak = process.memoryUsage();
    console.log('\n--- COST (this machine; Render free is 0.1 shared CPU / 512 MB) ---');
    console.log(`  SGP4 propagation      : ${propagateMs} ms for 5 satellites x ${WINDOW_HOURS}h @ ${STEP_SECONDS}s`);
    console.log(`  total wall clock      : ${Date.now() - wallStart} ms (includes network)`);
    console.log(`  heap used delta       : ${((memPeak.heapUsed - memStart) / 1048576).toFixed(1)} MB`);
    console.log(`  heap total            : ${(memPeak.heapTotal / 1048576).toFixed(1)} MB`);
    console.log(`  rss                   : ${(memPeak.rss / 1048576).toFixed(1)} MB`);
    const points = [...tracks.values()].reduce((s, t) => s + t.length, 0);
    console.log(`  track points held     : ${points} (${((points * 40) / 1024).toFixed(0)} KB, discarded after the run)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
