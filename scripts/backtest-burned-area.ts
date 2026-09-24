/**
 * Backtest the AppEEARS → MCD64A1 → hectares path against two fires whose
 * size is public knowledge, WITHOUT touching the database:
 *
 *   Manavgat (Antalya), 28 Jul – early Aug 2021   press ~50 000 ha, İTÜ ~66 000 ha (district)
 *   Marmaris (Muğla),   29 Jul – 6 Aug 2021       OGM 13 650 ha
 *
 *   EARTHDATA_USERNAME=... EARTHDATA_PASSWORD=... npm run backtest:burned-area
 *   npm run backtest:burned-area -- --task <task_id>     # resume: skip submit, just fetch
 *
 * What it proves when it passes:
 *   * the service account can log in and submit an area task
 *   * AppEEARS accepts a MultiPolygon feature (the job sends the country as one)
 *   * the bundle's file names parse and the rasters are sinusoidal
 *   * pixel count × 21.47 ha lands in the right order of magnitude
 *
 * MCD64A1 is known to under-map (500 m pixels, omission of small burns):
 * 70–110 % of the reference is a pass; well under that means the raster,
 * the projection or the boxes are wrong.
 */
import 'dotenv/config';
import {
  AppeearsClient,
  credentialsFromEnv,
  toAppeearsDate,
} from '../src/services/appeearsClient';
import {
  PIXEL_HECTARES,
  PRODUCT,
  extractBurnedPixels,
  parseBundleFileName,
  toIsoDate,
} from '../src/services/burnedAreaRaster';

interface Box {
  name: string;
  west: number;
  south: number;
  east: number;
  north: number;
  reference_ha: [number, number];
}

const BOXES: Box[] = [
  { name: 'Manavgat 2021', west: 31.15, south: 36.65, east: 32.0, north: 37.2, reference_ha: [50_000, 66_000] },
  { name: 'Marmaris 2021', west: 28.1, south: 36.75, east: 28.6, north: 37.05, reference_ha: [9_000, 13_650] },
];

const MONTHS = [new Date(Date.UTC(2021, 6, 1)), new Date(Date.UTC(2021, 7, 1))]; // Jul, Aug
const POLL_SECONDS = 60;
const MAX_WAIT_MINUTES = 120;

function ring(b: Box): number[][] {
  return [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]];
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

async function main() {
  const credentials = credentialsFromEnv();
  if (!credentials) throw new Error('EARTHDATA_USERNAME and EARTHDATA_PASSWORD are required');
  const client = new AppeearsClient(credentials);

  let taskId = arg('--task');
  if (!taskId) {
    const geo = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { name: 'backtest' },
          // ONE MultiPolygon on purpose: the job sends Türkiye the same way.
          geometry: { type: 'MultiPolygon', coordinates: BOXES.map((b) => [ring(b)]) },
        },
      ],
    };
    taskId = await client.submitAreaTask({
      taskName: 'firewatch-tr-backtest-2021',
      dates: MONTHS.map((m) => ({
        startDate: toAppeearsDate(m),
        endDate: toAppeearsDate(new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0))),
      })),
      layers: [{ product: PRODUCT, layer: 'Burn_Date' }],
      geo,
      projection: 'native',
    });
    console.log(`Submitted task ${taskId} (resume later with --task ${taskId})`);
  }

  const deadline = Date.now() + MAX_WAIT_MINUTES * 60_000;
  for (;;) {
    const status = await client.getTaskStatus(taskId);
    console.log(`${new Date().toISOString()}  status=${status.status}` +
      (status.progress?.summary !== undefined ? ` progress=${status.progress.summary}%` : ''));
    if (status.status === 'done') break;
    if (status.status === 'error') throw new Error(`task ended in error: ${JSON.stringify(status.error ?? '')}`);
    if (Date.now() > deadline) throw new Error(`gave up after ${MAX_WAIT_MINUTES} min; resume with --task ${taskId}`);
    await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
  }

  const files = await client.listBundle(taskId);
  console.log(`\nBundle: ${files.length} files`);
  for (const f of files) console.log(`  ${f.file_name}  (${f.file_size} B)`);

  const totals = new Map<string, number>(); // box → pixels, all months
  for (const file of files) {
    const meta = parseBundleFileName(file.file_name);
    if (!meta || meta.layer !== 'Burn_Date') continue;
    const buffer = await client.downloadFile(taskId, file.file_id);
    const summary = await extractBurnedPixels(buffer, null, meta.month.getUTCFullYear());
    console.log(
      `\n${toIsoDate(meta.month).slice(0, 7)}: raster ${summary.width}x${summary.height}, ` +
        `${summary.burnedPixelCount} burned px, ${summary.unexpectedValueCount} unexpected values`
    );
    for (const box of BOXES) {
      const inBox = summary.pixels.filter(
        (p) => p.lon >= box.west && p.lon <= box.east && p.lat >= box.south && p.lat <= box.north
      );
      const days = new Set(inBox.map((p) => toIsoDate(p.burnDate)));
      console.log(
        `  ${box.name.padEnd(15)} ${String(inBox.length).padStart(5)} px = ` +
          `${(inBox.length * PIXEL_HECTARES).toFixed(0).padStart(6)} ha` +
          (days.size ? `  burn dates ${[...days].sort()[0]} .. ${[...days].sort().pop()}` : '')
      );
      totals.set(box.name, (totals.get(box.name) ?? 0) + inBox.length);
    }
  }

  console.log('\n=== Jul+Aug 2021 vs reference ===');
  let ok = true;
  for (const box of BOXES) {
    const ha = (totals.get(box.name) ?? 0) * PIXEL_HECTARES;
    const [lo, hi] = box.reference_ha;
    const ratioLo = ha / lo;
    const verdict = ha >= 0.7 * lo && ha <= 1.1 * hi ? 'PASS' : 'FAIL';
    if (verdict === 'FAIL') ok = false;
    console.log(
      `${verdict}  ${box.name.padEnd(15)} MCD64A1 ${ha.toFixed(0).padStart(6)} ha   ` +
        `reference ${lo}–${hi} ha   (${(ratioLo * 100).toFixed(0)}% of the low reference)`
    );
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error?.response?.data ?? error);
  process.exit(1);
});
