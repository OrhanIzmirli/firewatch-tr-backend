/**
 * Integration test for the shadow-mode news→incident verification job.
 *
 * Run against a DISPOSABLE PostGIS database with the schema and migrations
 * 001–007 applied (never against production — this seeds and deletes rows).
 * Two things the repo's SQL does not create and the test needs: a
 * `turkey_cities` table (id, name, region, location) holding at least Muğla,
 * Antalya, İzmir, Aydın, Balıkesir and Çanakkale, and `news.source_id`
 * (present in production, absent from schema.sql):
 *
 *   DATABASE_URL=postgresql://firewatch_user:...@localhost:5433/firewatch_db \
 *     npm run test:news-verification
 *
 * Seeds one incident/news pair per outcome the pipeline can produce, runs
 * the job exactly as cron would, and asserts every article landed on the
 * expected verdict — including that the one matchable pair matched the
 * RIGHT incident, and that an incident with an official_state is never a
 * candidate. Everything it created is tagged and removed at the end.
 */
import assert from 'node:assert';
import pool from '../src/config/database';
import newsVerificationJob from '../src/jobs/newsVerificationJob';

/** Tag every seeded row so cleanup can never touch anything else. */
const TAG = 'nv-test://';

interface SeedIncident {
  key: string;
  city: string;
  officialState?: 'ongoing' | 'contained' | 'extinguished';
}

const INCIDENTS: SeedIncident[] = [
  { key: 'mugla-open', city: 'Muğla' },
  // Same province, already officially closed — must NOT count as a candidate,
  // otherwise Muğla would have two and the match would (wrongly) refuse.
  { key: 'mugla-closed', city: 'Muğla', officialState: 'contained' },
  { key: 'antalya-open', city: 'Antalya' },
  { key: 'canakkale-a', city: 'Çanakkale' },
  { key: 'canakkale-b', city: 'Çanakkale' },
  // Balıkesir deliberately has no incident at all.
];

interface SeedNews {
  key: string;
  title: string;
  /** Default 1h. 'no_incident' is only ever written once the 24h lookahead
   *  has elapsed, so cases expecting it must be published earlier. */
  publishedHoursAgo?: number;
  expect: {
    outcome: string;
    claimState?: string | null;
    incidentKey?: string;
  };
}

const NEWS: SeedNews[] = [
  {
    key: 'matched-contained',
    title: "Muğla'nın Marmaris ilçesinde çıkan orman yangını kontrol altına alındı",
    expect: { outcome: 'matched', claimState: 'contained', incidentKey: 'mugla-open' },
  },
  {
    key: 'matched-ongoing',
    title: "Antalya'da orman yangını söndürülemedi, alevler ormanlık alanda yayılıyor",
    expect: { outcome: 'matched', claimState: 'ongoing', incidentKey: 'antalya-open' },
  },
  {
    key: 'two-provinces',
    title: "İzmir ve Aydın'da orman yangınları devam ediyor",
    expect: { outcome: 'multiple_cities' },
  },
  {
    key: 'no-incident',
    title: "Balıkesir'de çıkan orman yangını tamamen söndürüldü",
    publishedHoursAgo: 30,
    expect: { outcome: 'no_incident', claimState: 'extinguished' },
  },
  {
    // Same shape but fresh: the satellite may still see this fire, so no
    // verdict may be written yet — the row must simply not exist.
    key: 'deferred',
    title: "Aydın'da çıkan orman yangını kontrol altına alındı",
    publishedHoursAgo: 1,
    expect: { outcome: 'deferred' },
  },
  {
    key: 'ambiguous-incidents',
    title: "Çanakkale'de orman yangını kontrol altına alındı",
    expect: { outcome: 'multiple_incidents', claimState: 'contained' },
  },
  {
    key: 'structure-fire',
    title: "Muğla'da fabrika yangını söndürüldü",
    expect: { outcome: 'irrelevant' },
  },
  {
    key: 'no-claim',
    title: "Muğla'da ormanlık alanda yangın çıktı, ekipler bölgeye sevk edildi",
    expect: { outcome: 'no_claim' },
  },
];

async function cityId(name: string): Promise<number> {
  const r = await pool.query(`SELECT id FROM turkey_cities WHERE name = $1`, [name]);
  assert.ok(r.rows.length === 1, `turkey_cities must contain ${name}`);
  return Number(r.rows[0].id);
}

async function seed(): Promise<Map<string, number>> {
  const incidentIds = new Map<string, number>();

  for (const inc of INCIDENTS) {
    const id = await cityId(inc.city);
    const r = await pool.query(
      `INSERT INTO fire_incidents
         (first_detected_at, last_detected_at, detection_count,
          centroid, footprint, city_id,
          satellite_state, hours_since_last_detection,
          official_state, official_source, official_source_url,
          official_confirmed_at, official_note)
       SELECT NOW() - INTERVAL '26 hours', NOW() - INTERVAL '2 hours', 3,
              location::geometry,
              ST_Multi(ST_Collect(ARRAY[location::geometry])),
              id,
              'detected_recently', 2.0,
              $2, CASE WHEN $2::text IS NULL THEN NULL ELSE 'test' END,
              CASE WHEN $2::text IS NULL THEN NULL ELSE $3 END,
              CASE WHEN $2::text IS NULL THEN NULL ELSE NOW() END,
              $3
         FROM turkey_cities WHERE id = $1
       RETURNING fire_incidents.id`,
      [id, inc.officialState ?? null, `${TAG}${inc.key}`]
    );
    incidentIds.set(inc.key, Number(r.rows[0].id));
  }

  for (const article of NEWS) {
    await pool.query(
      `INSERT INTO news (title, summary, body, source, source_url,
                         category, published_at)
       VALUES ($1::varchar, $1::text, $1::text, 'nv-test', $2, 'Güncelleme',
               NOW() - make_interval(hours => $3))`,
      [article.title, `${TAG}${article.key}`, article.publishedHoursAgo ?? 1]
    );
  }

  return incidentIds;
}

async function cleanup(): Promise<void> {
  // Claim rows cascade away with their news rows. Every seeded incident —
  // open or closed — carries the tag in official_note (allowed while
  // official_state is NULL; the provenance constraint only binds when a
  // state is set), so a crashed previous run leaves nothing behind.
  await pool.query(`DELETE FROM news WHERE source_url LIKE $1`, [`${TAG}%`]);
  await pool.query(`DELETE FROM fire_incidents WHERE official_note LIKE $1`, [
    `${TAG}%`,
  ]);
}

async function main() {
  console.log('--- seeding ---');
  // Re-run safety: clear any leftovers from a previous crashed run first.
  await cleanup();

  const incidentIds = await seed();
  console.log(`seeded ${incidentIds.size} incidents, ${NEWS.length} articles`);

  console.log('--- running verification job ---');
  await newsVerificationJob.runVerification();

  const claims = await pool.query(
    `SELECT n.source_url, c.outcome, c.claim_state, c.claim_phrase, c.claim_rule,
            c.city_name, c.candidate_count, c.incident_id
       FROM incident_news_claims c
       JOIN news n ON n.id = c.news_id
      WHERE n.source_url LIKE $1`,
    [`${TAG}%`]
  );

  let failures = 0;
  for (const article of NEWS) {
    const row = claims.rows.find(
      (r: any) => r.source_url === `${TAG}${article.key}`
    );
    const label = article.key.padEnd(20);
    if (article.expect.outcome === 'deferred') {
      if (row) {
        console.log(`FAIL  ${label} verdict written (${row.outcome}) but lookahead has not elapsed`);
        failures++;
      } else {
        console.log(`PASS  ${label} deferred           (no row yet, re-judged next run)`);
      }
      continue;
    }
    if (!row) {
      console.log(`FAIL  ${label} no claim row written`);
      failures++;
      continue;
    }
    const problems: string[] = [];
    if (row.outcome !== article.expect.outcome) {
      problems.push(`outcome=${row.outcome} expected=${article.expect.outcome}`);
    }
    if (
      article.expect.claimState !== undefined &&
      row.claim_state !== article.expect.claimState
    ) {
      problems.push(`state=${row.claim_state} expected=${article.expect.claimState}`);
    }
    if (article.expect.incidentKey) {
      const expectedId = incidentIds.get(article.expect.incidentKey);
      if (Number(row.incident_id) !== expectedId) {
        problems.push(`incident=${row.incident_id} expected=${expectedId}`);
      }
    }
    if (problems.length > 0) {
      console.log(`FAIL  ${label} ${problems.join('; ')}`);
      failures++;
    } else {
      const detail =
        row.outcome === 'matched'
          ? `state=${row.claim_state} phrase="${row.claim_phrase}" incident=${row.incident_id}`
          : `(${row.city_name ?? '-'}, candidates=${row.candidate_count})`;
      console.log(`PASS  ${label} ${row.outcome.padEnd(18)} ${detail}`);
    }
  }

  // The job must also have recorded its own run.
  const run = await pool.query(
    `SELECT status, stats FROM job_runs WHERE job = 'news_verify'
      ORDER BY finished_at DESC LIMIT 1`
  );
  assert.ok(run.rows.length === 1 && run.rows[0].status === 'ok',
    'job_runs must contain an ok news_verify run');
  console.log(`job_runs: status=${run.rows[0].status} stats=${JSON.stringify(run.rows[0].stats)}`);

  console.log('--- cleanup ---');
  await cleanup();

  if (failures > 0) {
    console.log(`\n${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log('\nALL PASS');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
