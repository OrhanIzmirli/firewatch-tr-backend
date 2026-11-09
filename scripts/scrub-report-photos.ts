/**
 * One-off: removes metadata from report photos stored before uploads were
 * cleaned. Dry run by default; --apply writes. Prints counts only.
 *
 *   DATABASE_URL=... npx ts-node --project tsconfig.scripts.json scripts/scrub-report-photos.ts [--apply]
 *
 * Take a Neon backup branch before --apply.
 */
import { Client } from 'pg';
import { stripImageMetadata } from '../src/utils/imageMetadata';

const DATA_URI = /^(data:image\/[a-z]+;base64,)(.*)$/is;

export function scrubDataUri(uri: string): { value: string; changed: boolean; unreadable: boolean } {
  const match = uri.match(DATA_URI);
  if (!match) return { value: uri, changed: false, unreadable: true };
  try {
    const before = Buffer.from(match[2], 'base64');
    const after = stripImageMetadata(before);
    return after.equals(before)
      ? { value: uri, changed: false, unreadable: false }
      : { value: match[1] + after.toString('base64'), changed: true, unreadable: false };
  } catch {
    return { value: uri, changed: false, unreadable: true };
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const totals = { reports: 0, photos: 0, cleaned: 0, unreadable: 0, reportsChanged: 0 };
  try {
    const ids = await client.query(`SELECT id FROM fire_reports WHERE cardinality(photo_urls) > 0 ORDER BY id`);
    for (const { id } of ids.rows) {
      totals.reports++;
      const row = await client.query(`SELECT photo_urls FROM fire_reports WHERE id = $1`, [id]);
      const results = (row.rows[0].photo_urls as string[]).map(scrubDataUri);
      totals.photos += results.length;
      totals.cleaned += results.filter((r) => r.changed).length;
      totals.unreadable += results.filter((r) => r.unreadable).length;
      if (!results.some((r) => r.changed)) continue;
      totals.reportsChanged++;
      if (apply) await client.query(`UPDATE fire_reports SET photo_urls = $2 WHERE id = $1`, [id, results.map((r) => r.value)]);
    }
  } finally {
    await client.end();
  }
  console.log(JSON.stringify({ apply, ...totals }));
}

if (require.main === module) {
  main().catch((e) => {
    console.error('scrub failed:', (e as Error).message.replace(/postgres\S+/g, '<redacted>'));
    process.exit(1);
  });
}
