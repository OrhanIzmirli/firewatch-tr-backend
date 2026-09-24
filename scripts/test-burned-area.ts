/**
 * Unit tests for the burned-area pipeline's pure parts. No database, no
 * network, no Earthdata account:
 *
 *   npm run test:burned-area
 *
 *   1. MODIS sinusoidal ↔ lon/lat, against the published tile grid
 *   2. AppEEARS bundle file names → (product, layer, month)
 *   3. Burned-pixel extraction from a synthetic GeoTIFF written in memory
 *   4. Month eligibility for the fetch state machine
 *   5. geoBoundaries name → our district, every real mismatch from the
 *      2021 release plus the homonyms that must NOT cross provinces
 *
 * The AppEEARS round-trip, the raster of a real month and the SQL are
 * exercised by running the job once (GET /api/admin/burned-area) against a
 * database with migration 010 applied and reading /api/health/pipeline;
 * there is no disposable-DB harness for it.
 */
import assert from 'node:assert';
import {
  MODIS_500M_PIXEL_M,
  PIXEL_HECTARES,
  dateFromOrdinalDay,
  extractBurnedPixels,
  hectaresForPixels,
  lonLatToSinusoidal,
  parseBundleFileName,
  sinusoidalToLonLat,
  toIsoDate,
} from '../src/services/burnedAreaRaster';
import { eligibleMonths, parseBackfillFrom } from '../src/services/burnedAreaSchedule';
import {
  DistrictNameRef,
  matchDistrictName,
  stripMerkezSuffix,
} from '../src/services/districtBoundaryMatch';

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}
async function checkAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`);
  }
}
const close = (a: number, b: number, tol: number, what: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

const TILE_M = 1111950.5197; // one MODIS tile edge, metres

/**
 * Hand-built little-endian, uncompressed, single-strip int16 GeoTIFF.
 * geotiff's own writer only handles 8-bit imagery correctly, so the test
 * writes the twelve tags a reader needs by itself. Coordinates: upper-left
 * corner at (x0, y0), square pixels of `pixel`; `gcs` 4326 marks a
 * geographic raster, anything else a user-defined projected one.
 */
function syntheticTiff(values: number[], width: number, height: number, x0: number, y0: number, pixel = MODIS_500M_PIXEL_M, gcs = 32767): Buffer {
  const SHORT = 3, LONG = 4, DOUBLE = 12;
  const geoKeys = gcs === 4326
    ? [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]
    : [1, 1, 0, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32767];
  const pixelBytes = width * height * 2;
  const dataOffset = 8;
  const scaleOffset = dataOffset + pixelBytes + (pixelBytes % 2);
  const tieOffset = scaleOffset + 3 * 8;
  const keysOffset = tieOffset + 6 * 8;
  const ifdOffset = keysOffset + geoKeys.length * 2;
  const entries: [number, number, number, number][] = [
    [256, SHORT, 1, width], [257, SHORT, 1, height], [258, SHORT, 1, 16], [259, SHORT, 1, 1],
    [262, SHORT, 1, 1], [273, LONG, 1, dataOffset], [277, SHORT, 1, 1], [278, SHORT, 1, height],
    [279, LONG, 1, pixelBytes], [284, SHORT, 1, 1], [339, SHORT, 1, 2],
    [33550, DOUBLE, 3, scaleOffset], [33922, DOUBLE, 6, tieOffset], [34735, SHORT, geoKeys.length, keysOffset],
  ];
  const buf = Buffer.alloc(ifdOffset + 2 + entries.length * 12 + 4);
  buf.write('II', 0, 'ascii');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(ifdOffset, 4);
  values.forEach((v, i) => buf.writeInt16LE(v, dataOffset + i * 2));
  [pixel, pixel, 0].forEach((v, i) => buf.writeDoubleLE(v, scaleOffset + i * 8));
  [0, 0, 0, x0, y0, 0].forEach((v, i) => buf.writeDoubleLE(v, tieOffset + i * 8));
  geoKeys.forEach((v, i) => buf.writeUInt16LE(v, keysOffset + i * 2));
  buf.writeUInt16LE(entries.length, ifdOffset);
  entries.forEach(([tag, type, count, value], i) => {
    const o = ifdOffset + 2 + i * 12;
    buf.writeUInt16LE(tag, o);
    buf.writeUInt16LE(type, o + 2);
    buf.writeUInt32LE(count, o + 4);
    if (type === SHORT && count === 1) buf.writeUInt16LE(value, o + 8);
    else buf.writeUInt32LE(value, o + 8);
  });
  buf.writeUInt32LE(0, ifdOffset + 2 + entries.length * 12);
  return buf;
}

async function main() {
  // -------------------------------------------------------------------------
  console.log('--- sinusoidal grid ---');
  check('pixel area is 21.47 ha', () => close(PIXEL_HECTARES, 21.4658, 0.001, 'ha'));
  check('2400 pixels make one tile', () => close(MODIS_500M_PIXEL_M * 2400, TILE_M, 0.01, 'tile'));
  check('tile h20v05 upper-left corner is at 40°N', () => {
    // Tile (h, v): x = (h − 18)·T, y = (9 − v)·T
    const { lat, lon } = sinusoidalToLonLat(2 * TILE_M, 4 * TILE_M);
    close(lat, 40, 1e-6, 'lat');
    close(lon, 26.108, 0.01, 'lon'); // 2T / (R·cos 40°)
  });
  check('equator: lon = x / R', () => {
    const { lat, lon } = sinusoidalToLonLat(TILE_M, 0);
    close(lat, 0, 1e-9, 'lat');
    close(lon, 10, 1e-6, 'lon');
  });
  check('forward then inverse round-trips over Türkiye', () => {
    for (const [lon, lat] of [[26.1, 40.0], [36.0, 37.0], [44.5, 39.7], [28.4, 36.9]]) {
      const { x, y } = lonLatToSinusoidal(lon, lat);
      const back = sinusoidalToLonLat(x, y);
      close(back.lon, lon, 1e-9, 'lon');
      close(back.lat, lat, 1e-9, 'lat');
    }
  });

  // -------------------------------------------------------------------------
  console.log('--- bundle file names ---');
  check('Burn_Date for July 2026', () => {
    const p = parseBundleFileName('MCD64A1.061_Burn_Date_doy2026182_aid0001.tif');
    assert.ok(p);
    assert.strictEqual(p!.product, 'MCD64A1.061');
    assert.strictEqual(p!.layer, 'Burn_Date');
    assert.strictEqual(toIsoDate(p!.month), '2026-07-01');
  });
  check('QA for January 2025', () => {
    const p = parseBundleFileName('MCD64A1.061_QA_doy2025001_aid0001.tif');
    assert.strictEqual(p?.layer, 'QA');
    assert.strictEqual(toIsoDate(p!.month), '2025-01-01');
  });
  check('statistics CSV and lookup are not rasters', () => {
    assert.strictEqual(parseBundleFileName('MCD64A1-061-Statistics.csv'), null);
    assert.strictEqual(parseBundleFileName('MCD64A1-061-QA-lookup.csv'), null);
    assert.strictEqual(parseBundleFileName('firewatch-request.json'), null);
  });
  check('ordinal day 213 of 2021 is 1 August', () =>
    assert.strictEqual(toIsoDate(dateFromOrdinalDay(2021, 213)), '2021-08-01'));

  // -------------------------------------------------------------------------
  console.log('--- raster extraction ---');
  const X0 = 2 * TILE_M; // h20 left edge
  const Y0 = 4 * TILE_M; // v05 top edge
  const BURN = syntheticTiff(
    [
      0, 0, -1, -2, //
      0, 213, 214, 0, //
      0, 0, 0, 999, // 999 = unexpected value
    ],
    4, 3, X0, Y0
  );
  const QA = syntheticTiff(
    [
      0, 0, 0, 0, //
      0, 3, 7, 0, //
      0, 0, 0, 0,
    ],
    4, 3, X0, Y0
  );

  await checkAsync('two burned pixels, one unexpected value, codes dropped', async () => {
    const summary = await extractBurnedPixels(BURN, QA, 2021);
    assert.strictEqual(summary.pixelCount, 12);
    assert.strictEqual(summary.burnedPixelCount, 2);
    assert.strictEqual(summary.unexpectedValueCount, 1);
    const [a, b] = summary.pixels;
    assert.deepStrictEqual([a.row, a.col, a.doy, a.qa], [1, 1, 213, 3]);
    assert.deepStrictEqual([b.row, b.col, b.doy, b.qa], [1, 2, 214, 7]);
    assert.strictEqual(toIsoDate(a.burnDate), '2021-08-01');
    // Pixel (row 1, col 1) centre: x0 + 1.5 px, y0 − 1.5 px
    const expected = sinusoidalToLonLat(X0 + 1.5 * MODIS_500M_PIXEL_M, Y0 - 1.5 * MODIS_500M_PIXEL_M);
    close(a.lon, expected.lon, 1e-9, 'lon');
    close(a.lat, expected.lat, 1e-9, 'lat');
    close(a.lat, 39.9937, 0.001, 'lat just under 40°N');
  });
  await checkAsync('QA of a different shape is refused', async () => {
    const smallQa = syntheticTiff([0, 0, 0, 0], 2, 2, X0, Y0);
    await assert.rejects(() => extractBurnedPixels(BURN, smallQa, 2021), /does not match/);
  });
  await checkAsync('a geographic (degrees) raster is refused', async () => {
    const degrees = syntheticTiff([0, 0, 0, 0], 2, 2, 26, 40, 0.0041667, 4326);
    await assert.rejects(() => extractBurnedPixels(degrees, null, 2021), /degrees/);
  });
  check('hectares round to a hundredth', () => assert.strictEqual(hectaresForPixels(3), 64.4));

  // -------------------------------------------------------------------------
  console.log('--- month eligibility ---');
  check('backfill env parses, garbage falls back', () => {
    assert.strictEqual(toIsoDate(parseBackfillFrom('2025-01', '2026-01')), '2025-01-01');
    assert.strictEqual(toIsoDate(parseBackfillFrom('nonsense', '2026-01')), '2026-01-01');
    assert.strictEqual(toIsoDate(parseBackfillFrom(undefined, '2026-03')), '2026-03-01');
  });
  check('on 24 Sep 2026 the newest eligible month is July', () => {
    const months = eligibleMonths(new Date('2026-09-24T12:00:00Z'), new Date('2026-05-01T00:00:00Z'));
    assert.deepStrictEqual(months.map(toIsoDate), ['2026-05-01', '2026-06-01', '2026-07-01']);
  });
  check('August becomes eligible on 1 October, not before', () => {
    const before = eligibleMonths(new Date('2026-09-30T23:00:00Z'), new Date('2026-08-01T00:00:00Z'));
    const after = eligibleMonths(new Date('2026-10-01T01:00:00Z'), new Date('2026-08-01T00:00:00Z'));
    assert.deepStrictEqual(before.map(toIsoDate), []);
    assert.deepStrictEqual(after.map(toIsoDate), ['2026-08-01']);
  });

  // -------------------------------------------------------------------------
  console.log('--- geoBoundaries name matching ---');
  let id = 1;
  const d = (name: string, provinceName: string): DistrictNameRef => ({ id: id++, name, provinceName });
  const P: Record<string, DistrictNameRef[]> = {
    Elazığ: [d('Merkez', 'Elazığ'), d('Maden', 'Elazığ')],
    Kilis: [d('Merkez', 'Kilis'), d('Elbeyli', 'Kilis')],
    Giresun: [d('Merkez', 'Giresun'), d('Bulancak', 'Giresun')],
    Afyonkarahisar: [d('Merkez', 'Afyonkarahisar'), d('Sandıklı', 'Afyonkarahisar')],
    Rize: [d('Merkez', 'Rize'), d('Ardeşen', 'Rize'), d('Fındıklı', 'Rize')],
    Ardahan: [d('Merkez', 'Ardahan'), d('Göle', 'Ardahan')],
    Kütahya: [d('Merkez', 'Kütahya'), d('Gediz', 'Kütahya')],
    Çanakkale: [d('Merkez', 'Çanakkale'), d('Gökçeada', 'Çanakkale'), d('Ayvacık', 'Çanakkale')],
    İstanbul: [d('Adalar', 'İstanbul'), d('Kartal', 'İstanbul')],
    Erzincan: [d('Merkez', 'Erzincan'), d('İliç', 'Erzincan')],
    Niğde: [d('Merkez', 'Niğde'), d('Ulukışla', 'Niğde')],
    Kırıkkale: [d('Merkez', 'Kırıkkale'), d('Bahşili', 'Kırıkkale'), d('Karakeçili', 'Kırıkkale')],
    Antalya: [d('Kemer', 'Antalya'), d('İbradı', 'Antalya'), d('Kaş', 'Antalya')],
    Isparta: [d('Merkez', 'Isparta'), d('Şarkikaraağaç', 'Isparta')],
    Diyarbakır: [d('Sur', 'Diyarbakır'), d('Yenişehir', 'Diyarbakır'), d('Kayapınar', 'Diyarbakır')],
    Bursa: [d('Yenişehir', 'Bursa'), d('Osmangazi', 'Bursa'), d('Nilüfer', 'Bursa')],
    Burdur: [d('Merkez', 'Burdur'), d('Kemer', 'Burdur')],
  };
  const expectMatch = (shape: string, province: string, ours: string) =>
    check(`"${shape}" @ ${province} → ${ours}`, () => {
      const hit = matchDistrictName(shape, province, P[province]);
      assert.ok(hit, 'no match');
      assert.strictEqual(hit!.name, ours);
    });
  const expectRefuse = (shape: string, province: string) =>
    check(`"${shape}" @ ${province} → refused`, () =>
      assert.strictEqual(matchDistrictName(shape, province, P[province]), null));

  check('stripMerkezSuffix variants', () => {
    assert.strictEqual(stripMerkezSuffix('Elazığ merkez'), 'Elazığ');
    assert.strictEqual(stripMerkezSuffix('Kilis (merkez)'), 'Kilis');
    assert.strictEqual(stripMerkezSuffix('Afyonkarahisar (Merkez İlçe)'), 'Afyonkarahisar');
    assert.strictEqual(stripMerkezSuffix('Rize merkezi'), 'Rize');
    assert.strictEqual(stripMerkezSuffix('Giresun District'), 'Giresun');
    assert.strictEqual(stripMerkezSuffix('Gediz Merkez'), 'Gediz');
    assert.strictEqual(stripMerkezSuffix('Merkez'), null);
    assert.strictEqual(stripMerkezSuffix('Kemer'), null);
  });
  expectMatch('Elazığ merkez', 'Elazığ', 'Merkez');
  expectMatch('Kilis (merkez)', 'Kilis', 'Merkez');
  expectMatch('Giresun District', 'Giresun', 'Merkez');
  expectMatch('Afyonkarahisar (Merkez İlçe)', 'Afyonkarahisar', 'Merkez');
  expectMatch('Rize merkezi', 'Rize', 'Merkez');
  expectMatch('Ardahan', 'Ardahan', 'Merkez');
  expectMatch('Gediz Merkez', 'Kütahya', 'Gediz');
  expectMatch('Imbros', 'Çanakkale', 'Gökçeada');
  expectMatch('Ayvacik', 'Çanakkale', 'Ayvacık');
  expectMatch('Prince Islands', 'İstanbul', 'Adalar');
  expectMatch('Ilıç', 'Erzincan', 'İliç');
  expectMatch('Ulukisla', 'Niğde', 'Ulukışla');
  expectMatch('Bahşılı', 'Kırıkkale', 'Bahşili');
  expectMatch('Karakeçeli', 'Kırıkkale', 'Karakeçili');
  expectMatch('İbradi', 'Antalya', 'İbradı');
  expectMatch('Şarkîkaraağaç', 'Isparta', 'Şarkikaraağaç');
  expectMatch('Fındıklı', 'Rize', 'Fındıklı');
  expectMatch('Kemer', 'Antalya', 'Kemer');
  expectMatch('Kemer', 'Burdur', 'Kemer');
  expectMatch('Yenişehir', 'Diyarbakır', 'Yenişehir');
  expectMatch('Yenişehir', 'Bursa', 'Yenişehir');
  expectRefuse('Derecik', 'Rize'); // exists in Hakkari only; here it must not guess
  expectRefuse('Kemer', 'Rize');

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
