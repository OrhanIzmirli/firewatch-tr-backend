/**
 * Runs GET /api/history (the real router, behind the same compression()
 * middleware as server.ts) against a real PostGIS database.
 *
 *   TEST_DATABASE_URL=postgres://... npm run test:fire-history-db
 *
 * Use a throwaway database (a local postgis/postgis container, or a Neon
 * branch). It refuses to run against the DATABASE_URL in .env. Everything is
 * created in a schema `fh_test` that shadows public and is dropped at the
 * end, so nothing outside it is read or written.
 *
 * Checks that city is always the district's own province (the bug: city came
 * from fire_incidents.city_id, the nearest province *centre*, and paired
 * "Diyarbakır" with Siverek), that "İçel" is shown as "Mersin", and that the
 * response is gzip-compressed when the client asks for it (Dart's
 * HttpClient, under Dio, always does).
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { join } from 'node:path';
import zlib from 'node:zlib';
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

const SCHEMA = 'fh_test';
// The router's pool is built from DATABASE_URL on import: aim it at the test
// database with fh_test first on its search_path. No REDIS_URL, so no cache.
const routed = new URL(url);
routed.searchParams.set('options', `-c search_path=${SCHEMA},public`);
process.env.DATABASE_URL = routed.toString();
delete process.env.REDIS_URL;
process.env.NODE_ENV = 'test';

/* eslint-disable @typescript-eslint/no-var-requires */
const express = require('express') as typeof import('express');
const compression = require('compression') as typeof import('compression');
const historyRoutes = (require('../src/routes/history') as typeof import('../src/routes/history')).default;
const pool = (require('../src/config/database') as typeof import('../src/config/database')).default;
/* eslint-enable @typescript-eslint/no-var-requires */

let failures = 0;
async function b(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
}

interface SeedRow { province: string; district: string; lat: number; lng: number }
const seed = JSON.parse(
  readFileSync(join(__dirname, '..', 'database', 'seed', 'turkey_districts.json'), 'utf8').replace(/^﻿/, '')
) as SeedRow[];

/** Province centres as turkey_cities has them; Mersin under its old name, as in production. */
const CITIES: Array<[number, string, number, number]> = [
  [21, 'Diyarbakır', 37.9144, 40.2306],
  [63, 'Şanlıurfa', 37.1591, 38.7969],
  [33, 'İçel', 36.8121, 34.6415],
];

function get(port: number, path: string, encoding?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers: encoding ? { 'Accept-Encoding': encoding } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  const app = express();
  app.use(compression()); // as in src/server.ts
  app.use('/api/history', historyRoutes);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  const features = async (from: string, to: string) => {
    const r = await get(port, `/api/history?from=${from}&to=${to}`);
    assert.strictEqual(r.status, 200, r.body.toString());
    return JSON.parse(r.body.toString()).features as Array<{ id: number; geometry: any; properties: any }>;
  };

  try {
    await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await c.query(`CREATE SCHEMA ${SCHEMA}`);
    await c.query(`SET search_path = ${SCHEMA}, public`);
    await c.query(`CREATE EXTENSION IF NOT EXISTS postgis SCHEMA public`);
    await c.query(`CREATE TABLE turkey_cities (id INTEGER PRIMARY KEY, name TEXT NOT NULL, location geometry(Point, 4326))`);
    for (const [id, name, lat, lng] of CITIES) {
      await c.query(`INSERT INTO turkey_cities VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326))`, [id, name, lat, lng]);
    }
    const migration008 = readFileSync(join(__dirname, '..', 'database', 'migrations', '008_add_turkey_districts.sql'), 'utf8')
      .split('\n').filter((l) => !/^\s*(BEGIN|COMMIT);\s*$/.test(l)).join('\n');
    await c.query(migration008);
    // Every district in the seed, so "nearest district centre" is the real one.
    let pid = 1000;
    const provinceIds = new Map<string, number>([['Diyarbakır', 21], ['Şanlıurfa', 63], ['Mersin', 33]]);
    for (const r of seed) {
      if (!provinceIds.has(r.province)) provinceIds.set(r.province, pid++);
      await c.query(
        `INSERT INTO turkey_districts (name, province_id, province_name, location, source)
         VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint($4, $5), 4326), 'test')`,
        [r.district, provinceIds.get(r.province), r.province, r.lng, r.lat]
      );
    }
    await c.query(`CREATE TABLE fire_incidents (
      id BIGINT PRIMARY KEY,
      city_id INTEGER,
      centroid geometry(Point, 4326) NOT NULL,
      footprint geometry(MultiPoint, 4326) NOT NULL,
      first_detected_at TIMESTAMPTZ NOT NULL,
      last_detected_at TIMESTAMPTZ NOT NULL,
      detection_count INTEGER NOT NULL,
      max_frp_mw NUMERIC,
      distinct_days_seen INTEGER NOT NULL DEFAULT 1,
      frp_mean NUMERIC
    )`);
    // [id, city_id as the ingest job sets it (nearest province centre), lat, lng]
    const incidents: Array<[number, number, number, number]> = [
      [1, 21, 37.70, 39.47], // east of Siverek: nearest province centre is Diyarbakır
      [2, 33, 36.38, 33.93], // Silifke, Mersin; city_id row is named "İçel"
    ];
    for (const [id, cityId, lat, lng] of incidents) {
      await c.query(
        `INSERT INTO fire_incidents (id, city_id, centroid, footprint, first_detected_at, last_detected_at, detection_count, max_frp_mw, frp_mean)
         VALUES ($1, $2, ST_SetSRID(ST_MakePoint($4, $3), 4326),
                 ST_Multi(ST_Collect(ARRAY[
                   ST_SetSRID(ST_MakePoint($4, $3), 4326),
                   ST_SetSRID(ST_MakePoint($4::float8 + 0.003, $3::float8 + 0.002), 4326),
                   ST_SetSRID(ST_MakePoint($4::float8 + 0.05, $3::float8), 4326)])),
                 '2026-08-10T09:00:00Z', '2026-08-11T12:00:00Z', 12, 85.4, 40)`,
        [id, cityId, lat, lng]
      );
    }

    await b('fixture: the old city_id pairing really was wrong for incident 1', async () => {
      const r = await c.query(`
        SELECT ci.name AS city, d.name AS district, d.province_name
          FROM fire_incidents i JOIN turkey_cities ci ON ci.id = i.city_id
          CROSS JOIN LATERAL (SELECT name, province_name FROM turkey_districts td ORDER BY td.location <-> i.centroid LIMIT 1) d
         WHERE i.id = 1`);
      assert.deepStrictEqual(r.rows[0], { city: 'Diyarbakır', district: 'Siverek', province_name: 'Şanlıurfa' });
    });

    const fs = await features('2026-08-01', '2026-08-31');
    const byId = new Map(fs.map((f) => [f.id, f]));

    await b('city is the district\'s own province: Şanlıurfa / Siverek, not Diyarbakır', async () => {
      const p = byId.get(1)!.properties;
      assert.strictEqual(p.district, 'Siverek');
      assert.strictEqual(p.city, 'Şanlıurfa');
    });
    await b('Mersin is called Mersin, never İçel', async () => {
      const p = byId.get(2)!.properties;
      assert.strictEqual(p.district, 'Silifke');
      assert.strictEqual(p.city, 'Mersin');
    });
    await b('every item pairs a district with the province that owns it', async () => {
      const owner = new Map(seed.map((r) => [`${r.province}/${r.district}`, true]));
      for (const f of fs) assert.ok(owner.has(`${f.properties.city}/${f.properties.district}`), `${f.properties.city}/${f.properties.district}`);
    });
    await b('geometry: polygons only, ≤ 4 decimals, rings the app accepts (≥ 4 points)', async () => {
      for (const f of fs) {
        assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const poly of polys) for (const ring of poly) {
          assert.ok(ring.length >= 4, `ring of ${ring.length}`);
          for (const [x, y] of ring) {
            assert.ok(Math.abs(x * 1e4 - Math.round(x * 1e4)) < 1e-6 && Math.abs(y * 1e4 - Math.round(y * 1e4)) < 1e-6, `${x},${y}`);
          }
        }
        assert.strictEqual(f.properties.centroid.length, 2);
      }
    });

    await b('compression: gzip when asked, with Vary, and the body is the same JSON', async () => {
      const plain = await get(port, '/api/history?from=2026-08-01&to=2026-08-31');
      const gz = await get(port, '/api/history?from=2026-08-01&to=2026-08-31', 'gzip');
      assert.strictEqual(plain.headers['content-encoding'], undefined);
      assert.strictEqual(gz.headers['content-encoding'], 'gzip');
      assert.match(String(gz.headers.vary), /Accept-Encoding/i);
      assert.ok(gz.body.length < plain.body.length, `${gz.body.length} < ${plain.body.length}`);
      assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(gz.body).toString()), JSON.parse(plain.body.toString()));
    });
    await b('compression: br when the client prefers it', async () => {
      const br = await get(port, '/api/history?from=2026-08-01&to=2026-08-31', 'br, gzip');
      assert.strictEqual(br.headers['content-encoding'], 'br');
      JSON.parse(zlib.brotliDecompressSync(br.body).toString());
    });

    await b('without any district rows, city falls back to city_id, still "Mersin"', async () => {
      await c.query('TRUNCATE turkey_districts');
      const after = new Map((await features('2026-08-01', '2026-08-31')).map((f) => [f.id, f.properties]));
      assert.strictEqual(after.get(2)!.city, 'Mersin');
      assert.strictEqual(after.get(2)!.district, null);
      assert.strictEqual(after.get(2)!.district_basis, null);
      assert.strictEqual(after.get(1)!.city, 'Diyarbakır');
    });
  } finally {
    server.close();
    await pool.end();
    await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await c.end();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
