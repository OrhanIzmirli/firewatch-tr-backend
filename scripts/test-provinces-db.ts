/**
 * Migration 015 (province polygons) and the province backfill, against a
 * real PostGIS database.
 *
 *   TEST_DATABASE_URL=postgres://... npm run test:provinces-db
 *
 * Use a throwaway database (a local postgis/postgis container). Refuses the
 * DATABASE_URL in .env. Everything lives in schema `pv_test`, dropped at the
 * end. turkey_cities is production's 81 rows (scripts/fixtures, exported
 * read-only on 2026-11-07, Mersin still named "İçel" as in production).
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.log('TEST_DATABASE_URL not set — skipping (needs PostGIS).');
  process.exit(0);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config({ path: join(__dirname, '..', '.env'), quiet: true });
const prodHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : null;
if (prodHost && new URL(url).host === prodHost) {
  console.error('Refusing to run: TEST_DATABASE_URL points at the production database.');
  process.exit(1);
}

const SCHEMA = 'pv_test';
const routed = new URL(url);
routed.searchParams.set('options', `-c search_path=${SCHEMA},public`);
process.env.DATABASE_URL = routed.toString();
delete process.env.REDIS_URL;
process.env.NODE_ENV = 'test';

/* eslint-disable @typescript-eslint/no-var-requires */
const provinces = require('../src/services/provinces') as typeof import('../src/services/provinces');
const { historySql } = require('../src/services/fireHistory') as typeof import('../src/services/fireHistory');
const { backfill } = require('./backfill-provinces-015') as typeof import('./backfill-provinces-015');
const pool = (require('../src/config/database') as typeof import('../src/config/database')).default;
/* eslint-enable @typescript-eslint/no-var-requires */

let failures = 0;
async function b(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
}

const cities = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'turkey_cities.json'), 'utf8')) as
  Array<{ id: number; name: string; region: string; lat: number; lng: number }>;
const districtSeed = JSON.parse(
  readFileSync(join(__dirname, '..', 'database', 'seed', 'turkey_districts.json'), 'utf8').replace(/^﻿/, '')
) as Array<{ province: string; district: string; lat: number; lng: number }>;
const stripTx = (sql: string) => sql.split('\n').filter((l) => !/^\s*(BEGIN|COMMIT);\s*$/.test(l)).join('\n');

// Points with a known answer. [lat, lng, expected province id, label]
const SIVEREK_SE: [number, number] = [37.5990, 39.5184]; // incident 7059 in production
const KNOWN: Array<[number, number, number, string]> = [
  [SIVEREK_SE[0], SIVEREK_SE[1], 63, 'SE of Siverek → Şanlıurfa (nearest centre: Diyarbakır)'],
  [39.93, 32.85, 6, 'Kızılay → Ankara'],
  [36.38, 33.93, 33, 'Silifke → Mersin'],
  [37.88, 41.13, 72, 'Batman centre → Batman'],
  [36.50, 30.60, 7, 'Mediterranean, off Antalya → nearest: Antalya'],
  [36.95, 27.20, 48, 'Aegean, off Bodrum → nearest: Muğla'],
];

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await c.query(`CREATE SCHEMA ${SCHEMA}`);
    await c.query(`SET search_path = ${SCHEMA}, public`);
    await c.query(`CREATE EXTENSION IF NOT EXISTS postgis SCHEMA public`);
    await c.query(`CREATE TABLE turkey_cities (id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL, lat NUMERIC, lng NUMERIC,
                   region VARCHAR(50), location geometry(Point, 4326))`);
    for (const r of cities) {
      await c.query(`INSERT INTO turkey_cities VALUES ($1, $2, $3::numeric, $4::numeric, $5, ST_SetSRID(ST_MakePoint($4::float8, $3::float8), 4326))`,
        [r.id, r.name, r.lat, r.lng, r.region]);
    }
    await c.query(stripTx(readFileSync(join(__dirname, '..', 'database', 'migrations', '008_add_turkey_districts.sql'), 'utf8')));
    const idByName = new Map(cities.map((r) => [r.name === 'İçel' ? 'Mersin' : r.name, r.id]));
    for (const r of districtSeed) {
      await c.query(`INSERT INTO turkey_districts (name, province_id, province_name, location, source)
                     VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), 'test')`,
        [r.district, idByName.get(r.province), r.province, r.lng, r.lat]);
    }
    await c.query(`CREATE TABLE fire_incidents (id BIGINT PRIMARY KEY, city_id INTEGER, region_key TEXT,
      centroid geometry(Point, 4326) NOT NULL, footprint geometry(MultiPoint, 4326) NOT NULL,
      first_detected_at TIMESTAMPTZ NOT NULL, last_detected_at TIMESTAMPTZ NOT NULL, detection_count INTEGER NOT NULL,
      max_frp_mw NUMERIC, distinct_days_seen INTEGER NOT NULL DEFAULT 1, frp_mean NUMERIC)`);
    await c.query(`CREATE TABLE fire_detections (id BIGINT PRIMARY KEY, city_id INTEGER, region_key TEXT,
      nearest_city_km NUMERIC, geom geometry(Point, 4326) NOT NULL)`);
    await c.query(`CREATE TABLE news_reported_sightings (id BIGINT PRIMARY KEY, province_id INTEGER, region_key TEXT,
      location geography(Point, 4326))`);
    // Rows labelled the old way (nearest province centre) — as production has them.
    for (const [i, [lat, lng]] of KNOWN.entries()) {
      const p = `ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)`;
      await c.query(`INSERT INTO fire_incidents (id, city_id, region_key, centroid, footprint, first_detected_at, last_detected_at, detection_count, max_frp_mw, frp_mean)
        SELECT ${i + 1}, tc.id, replace(lower(translate(tc.region,'İIıÇçĞğÖöŞşÜü','iiiccggoossuu')),' ','_'), ${p}, ST_Multi(${p}),
               '2026-08-10T09:00:00Z', '2026-08-11T12:00:00Z', 12, 40, 30
          FROM turkey_cities tc ORDER BY tc.location <-> ${p} LIMIT 1`);
      await c.query(`INSERT INTO fire_detections (id, city_id, region_key, nearest_city_km, geom)
        SELECT ${i + 1}, tc.id, replace(lower(translate(tc.region,'İIıÇçĞğÖöŞşÜü','iiiccggoossuu')),' ','_'), 0, ${p}
          FROM turkey_cities tc ORDER BY tc.location <-> ${p} LIMIT 1`);
    }
    await c.query(`INSERT INTO news_reported_sightings VALUES (1, 21, 'guneydogu_anadolu', ST_SetSRID(ST_MakePoint(${SIVEREK_SE[1]}, ${SIVEREK_SE[0]}), 4326)::geography)`);

    await b('before 015: the resolver falls back to the nearest centre (Siverek → Diyarbakır)', async () => {
      provinces.resetProvinceCache();
      const r = await provinces.resolveProvince(pool, SIVEREK_SE[0], SIVEREK_SE[1]);
      assert.strictEqual(r?.name, 'Diyarbakır');
    });

    await c.query(readFileSync(join(__dirname, '..', 'database', 'migrations', '015_province_borders.sql'), 'utf8'));
    provinces.resetProvinceCache();

    await b('migration 015 loads 81 valid provinces and renames İçel to Mersin', async () => {
      const r = await c.query(`SELECT count(*)::int n, count(*) FILTER (WHERE NOT ST_IsValid(geom))::int bad,
                                      (SELECT name FROM turkey_cities WHERE id = 33) AS mersin FROM turkey_province_borders`);
      assert.deepStrictEqual(r.rows[0], { n: 81, bad: 0, mersin: 'Mersin' });
    });

    await b('province_for_point: inside → that province; at sea → nearest', async () => {
      for (const [lat, lng, id, label] of KNOWN) {
        const r = await c.query(`SELECT province_for_point(ST_SetSRID(ST_MakePoint($2, $1), 4326)) AS id`, [lat, lng]);
        assert.strictEqual(r.rows[0].id, id, label);
      }
    });

    await b('every province polygon contains its own centre or is nearest to it', async () => {
      const r = await c.query(`SELECT count(*)::int n FROM turkey_cities WHERE province_for_point(location) <> id`);
      assert.strictEqual(r.rows[0].n, 0);
    });

    await b('province_region_key matches the region_key vocabulary', async () => {
      const r = await c.query(`SELECT province_region_key(63) a, province_region_key(33) b, province_region_key(6) c, province_region_key(25) d`);
      assert.deepStrictEqual(r.rows[0], { a: 'guneydogu_anadolu', b: 'akdeniz', c: 'ic_anadolu', d: 'dogu_anadolu' });
    });

    await b('after 015 the shared resolver (nearest-city, subscriptions, reports) says Şanlıurfa', async () => {
      const r = await provinces.resolveProvince(pool, SIVEREK_SE[0], SIVEREK_SE[1]);
      assert.strictEqual(r?.name, 'Şanlıurfa');
      assert.ok(r!.distanceKm > 50 && r!.distanceKm < 120, `distance to the centre: ${r!.distanceKm}`);
      const many = await provinces.resolveProvinces(pool, KNOWN.map(([lat, lng]) => ({ lat, lng })));
      assert.deepStrictEqual(many.map((p) => p?.id), KNOWN.map((k) => k[2]));
    });

    await b('history pairs the polygon province with one of its own districts, even before the backfill', async () => {
      const r = await c.query(historySql(true), ['2026-08-01', '2026-08-31', 5]);
      const one = r.rows.find((x: any) => Number(x.id) === 1);
      assert.strictEqual(one.city, 'Şanlıurfa');
      assert.strictEqual(one.district, 'Siverek');
      const silifke = r.rows.find((x: any) => Number(x.id) === 3);
      assert.strictEqual(silifke.city, 'Mersin');
    });

    await b('backfill: reassigns, logs the old values, leaves nothing inconsistent', async () => {
      await c.query('BEGIN');
      const counts = await backfill(c);
      await c.query('COMMIT');
      assert.ok(counts.incidents >= 1 && counts.detections === counts.incidents, JSON.stringify(counts));
      assert.strictEqual(counts.sightings, 1);
      assert.strictEqual(counts.inconsistent, 0);
      const i1 = await c.query(`SELECT city_id, region_key FROM fire_incidents WHERE id = 1`);
      assert.deepStrictEqual(i1.rows[0], { city_id: 63, region_key: 'guneydogu_anadolu' });
      const log = await c.query(`SELECT old_city_id, new_city_id FROM province_reassign_015 WHERE table_name = 'fire_incidents' AND row_id = 1`);
      assert.deepStrictEqual(log.rows[0], { old_city_id: 21, new_city_id: 63 });
      const km = await c.query(`SELECT nearest_city_km::float8 km FROM fire_detections WHERE id = 1`);
      assert.ok(km.rows[0].km > 50, `nearest_city_km re-measured: ${km.rows[0].km}`);
    });

    await b('backfill is idempotent and the log allows an exact undo', async () => {
      await c.query('BEGIN');
      const again = await backfill(c);
      assert.deepStrictEqual([again.incidents, again.detections, again.sightings], [0, 0, 0]);
      await c.query(`UPDATE fire_incidents i SET city_id = l.old_city_id, region_key = l.old_region_key
                       FROM province_reassign_015 l WHERE l.table_name = 'fire_incidents' AND l.row_id = i.id`);
      const undone = await c.query(`SELECT city_id FROM fire_incidents WHERE id = 1`);
      assert.strictEqual(undone.rows[0].city_id, 21);
      await c.query('ROLLBACK');
    });

    await b('ingest assigns new detections by polygon (the real resolveBatch SQL)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ingest = (require('../src/jobs/fireIngestJob') as any).default;
      const [r] = await ingest.resolveBatch([{ latitude: SIVEREK_SE[0], longitude: SIVEREK_SE[1] }]);
      assert.strictEqual(r.cityId, 63);
      assert.ok(r.distanceKm > 50, `distance to Şanlıurfa's centre: ${r.distanceKm}`);
    });

    await b('clustering: a new incident takes its centre\'s province, and follows it as it grows', async () => {
      await c.query(`CREATE SEQUENCE fire_incidents_id_seq OWNED BY fire_incidents.id`);
      await c.query(`ALTER TABLE fire_incidents
        ALTER COLUMN id SET DEFAULT nextval('fire_incidents_id_seq'),
        ADD COLUMN overpass_times TIMESTAMPTZ[], ADD COLUMN overpass_count INTEGER,
        ADD COLUMN peak_confidence_tier TEXT, ADD COLUMN satellite_state TEXT,
        ADD COLUMN hours_since_last_detection NUMERIC, ADD COLUMN updated_at TIMESTAMPTZ`);
      await c.query(`ALTER TABLE fire_detections ADD COLUMN incident_id BIGINT`);
      await c.query(`SELECT setval('fire_incidents_id_seq', 1000)`);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cluster = (require('../src/jobs/fireClusterJob') as any).default;
      const at = new Date('2026-08-10T09:00:00Z');
      const wkt = (lat: number, lng: number) => `POINT(${lng} ${lat})`;
      const row = {
        detectionIds: [] as number[], firstDetectedAt: at, lastDetectedAt: at, detectionCount: 3, overpassTimes: [at],
        centroidWkt: wkt(SIVEREK_SE[0], SIVEREK_SE[1]),
        footprintWkt: `MULTIPOINT(${SIVEREK_SE[1]} ${SIVEREK_SE[0]})`,
        maxFrpMw: 20, peakConfidenceTier: 'nominal',
        cityId: 21, regionKey: 'guneydogu_anadolu', // the detections' old nearest-centre label
        seenDays: ['2026-08-10'], frpSum: 0, frpSumSq: 0, frpSampleCount: 0,
      };
      await cluster.createIncident(c, row);
      const created = await c.query(`SELECT id, city_id, region_key FROM fire_incidents WHERE id > 1000`);
      assert.deepStrictEqual({ city: created.rows[0].city_id, region: created.rows[0].region_key }, { city: 63, region: 'guneydogu_anadolu' });

      // The incident grows far into Batman: its centre moves, so does its province.
      const id = Number(created.rows[0].id);
      await cluster.extendIncident(c, id, {
        ...row, footprintWkt: 'MULTIPOINT(41.13 37.88, 41.14 37.89, 41.12 37.87, 41.135 37.885)',
      });
      // The centre of Siverek + four Batman points lies in Diyarbakır: the
      // province must be the one the NEW centre is in, not the first one.
      const grown = await c.query(
        `SELECT city_id, region_key, province_for_point(centroid) AS expected FROM fire_incidents WHERE id = $1`, [id]);
      assert.strictEqual(grown.rows[0].city_id, grown.rows[0].expected);
      assert.notStrictEqual(grown.rows[0].city_id, 63);
      assert.strictEqual(grown.rows[0].city_id, 21);
    });
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => undefined);
    await c.end();
    await pool.end();
  }
  console.log(failures === 0 ? '\nall passed' : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
