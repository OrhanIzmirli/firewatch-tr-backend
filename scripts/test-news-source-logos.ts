/**
 * Unit test for the news source logo map (utils/newsSourceLogos.ts) and the
 * logo files it serves from public/news-logos.
 *
 *   npm run test:news-source-logos
 *
 * Every source the scraper stores must either have a logo or be one of the
 * sources deliberately left on the app's letter mark. The source names are
 * read from newsScraperJob.ts as text, because importing the job would pull
 * in the database pool. Every file in public/news-logos must be a complete,
 * square PNG — nothing else may be served from there. No network access.
 */
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  NEWS_LOGO_DIR,
  STATIC_MOUNT_PATH,
  newsLogoFiles,
  sourceLogoUrl,
  withSourceLogo,
} from '../src/utils/newsSourceLogos';

const LETTER_MARK_ONLY = new Set(['NTV Türkiye', 'İzmir Haber', 'Bursa Haber', 'Sözcü']);
const LOGO_DIR = join(__dirname, '..', 'public', NEWS_LOGO_DIR);
const BASE = 'https://backend.test';

const scraperSource = readFileSync(join(__dirname, '../src/jobs/newsScraperJob.ts'), 'utf8');
const rssBlock = scraperSource.slice(scraperSource.indexOf('const RSS_SOURCES'));
const scrapedSources = [...rssBlock.matchAll(/source: '([^']+)'/g)].map(m => m[1]);

let failures = 0;
const b = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngInfo(bytes: Buffer): { width: number; height: number } {
  assert.ok(bytes.length > 33, 'file too short to be a PNG');
  assert.ok(bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'missing PNG signature');
  assert.strictEqual(bytes.subarray(12, 16).toString('latin1'), 'IHDR', 'first chunk is not IHDR');
  assert.strictEqual(bytes.subarray(bytes.length - 8, bytes.length - 4).toString('latin1'), 'IEND', 'file does not end with IEND (truncated?)');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

process.env.PUBLIC_BASE_URL = `${BASE}/`;

b('scraper source list was found', () => assert.ok(scrapedSources.length >= 10, `found ${scrapedSources.length}`));

for (const source of scrapedSources) {
  b(`${source} is covered`, () => {
    const url = sourceLogoUrl(source);
    if (LETTER_MARK_ONLY.has(source)) {
      assert.strictEqual(url, '', 'expected no logo (letter mark)');
    } else {
      assert.match(url, new RegExp(`^${BASE}${STATIC_MOUNT_PATH}/${NEWS_LOGO_DIR}/[a-z0-9-]+\\.png$`));
    }
  });
}

b('public/news-logos holds exactly the mapped files', () => {
  const onDisk = readdirSync(LOGO_DIR).sort();
  assert.deepStrictEqual(onDisk, [...newsLogoFiles()].sort());
});

for (const file of readdirSync(LOGO_DIR)) {
  b(`${file} is a complete square PNG of at least 128px`, () => {
    const { width, height } = pngInfo(readFileSync(join(LOGO_DIR, file)));
    assert.strictEqual(width, height, `${width}x${height} is not square`);
    assert.ok(width >= 128, `${width}px is too small`);
  });
}

b('trailing slash on PUBLIC_BASE_URL is dropped', () => {
  assert.ok(sourceLogoUrl('AA').startsWith(`${BASE}${STATIC_MOUNT_PATH}/`));
});
b('matching ignores case, İ and extra spaces', () => {
  assert.strictEqual(sourceLogoUrl('trt  haber'), sourceLogoUrl('TRT Haber'));
  assert.strictEqual(sourceLogoUrl('HÜRRIYET'.replace('Ü', 'ü')), sourceLogoUrl('Hürriyet'));
  assert.strictEqual(sourceLogoUrl(' AA '), sourceLogoUrl('AA'));
});
b('unknown, empty and null sources give an empty string', () => {
  assert.strictEqual(sourceLogoUrl('Bilinmeyen Gazete'), '');
  assert.strictEqual(sourceLogoUrl(''), '');
  assert.strictEqual(sourceLogoUrl(null), '');
  assert.strictEqual(sourceLogoUrl(undefined), '');
});
b('withSourceLogo adds the field without touching the row', () => {
  const row = { id: 1, source: 'AA', title: 't' };
  const out = withSourceLogo(row);
  assert.strictEqual(out.source_logo_url, sourceLogoUrl('AA'));
  assert.strictEqual(out.title, 't');
  assert.ok(!('source_logo_url' in row), 'input row was mutated');
});
b('without PUBLIC_BASE_URL no URL is produced', () => {
  const saved = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  try {
    assert.strictEqual(sourceLogoUrl('AA'), '');
  } finally {
    process.env.PUBLIC_BASE_URL = saved;
  }
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
