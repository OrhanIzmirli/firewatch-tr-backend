/**
 * Unit test for the history endpoint helpers (services/fireHistory.ts).
 *
 *   npm run test:fire-history
 *
 * No database: checks ?from&to validation, the inclusion rules and time
 * zone in the SQL, and that a row becomes a Feature in the app contract's
 * shape with area_ha null and NASA FIRMS as the source.
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIRMS_MAP_URL,
  HISTORY_MAX_RANGE_DAYS,
  HISTORY_BUFFER_M,
  HISTORY_GEOMETRY_DECIMALS,
  displayProvinceName,
  HISTORY_MIN_DETECTIONS,
  historySql,
  parseHistoryRange,
  parseIsoDate,
  toHistoryCollection,
  toHistoryFeature,
} from '../src/services/fireHistory';

let failures = 0;
const b = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

b('ISO dates: real calendar days only', () => {
  assert.strictEqual(parseIsoDate('2026-08-05'), '2026-08-05');
  assert.strictEqual(parseIsoDate('2026-02-29'), null);
  assert.strictEqual(parseIsoDate('2026-13-01'), null);
  assert.strictEqual(parseIsoDate('2026-8-5'), null);
  assert.strictEqual(parseIsoDate('2026-08-05T00:00:00Z'), null);
  assert.strictEqual(parseIsoDate(['2026-08-05']), null);
  assert.strictEqual(parseIsoDate(undefined), null);
});
b('range: both required', () => {
  assert.ok('error' in parseHistoryRange({ from: '2026-08-01' }));
  assert.ok('error' in parseHistoryRange({ to: '2026-08-01' }));
});
b('range: from after to is rejected, same day is fine', () => {
  assert.ok('error' in parseHistoryRange({ from: '2026-08-02', to: '2026-08-01' }));
  assert.deepStrictEqual(parseHistoryRange({ from: '2026-08-01', to: '2026-08-01' }), { from: '2026-08-01', to: '2026-08-01' });
});
b('range: up to 1,100 days inclusive, enough for the app presets', () => {
  assert.strictEqual(HISTORY_MAX_RANGE_DAYS, 1100);
  // "Geçen yazdan beri": June 1 of last year to today
  assert.ok(!('error' in parseHistoryRange({ from: '2025-06-01', to: '2026-11-06' })));
  // "Son 3 yıl": same day three years ago to today, across a leap day
  assert.ok(!('error' in parseHistoryRange({ from: '2023-11-06', to: '2026-11-06' })));
  assert.ok(!('error' in parseHistoryRange({ from: '2024-01-01', to: '2027-01-04' })), '1,100 days allowed');
  assert.ok('error' in parseHistoryRange({ from: '2024-01-01', to: '2027-01-05' }), '1,101 days rejected');
});

b('SQL: Istanbul day bounds, end day inclusive, overlap test', () => {
  const sql = historySql();
  assert.match(sql, /\(\$1::date\)::timestamp AT TIME ZONE 'Europe\/Istanbul' AS lo/);
  assert.match(sql, /\(\$2::date \+ 1\)::timestamp AT TIME ZONE 'Europe\/Istanbul' AS hi/);
  assert.match(sql, /i\.first_detected_at < b\.hi/);
  assert.match(sql, /i\.last_detected_at >= b\.lo/);
});
b('SQL: ≥5 detections, heat sources excluded null-safely, no migration 011 dependency', () => {
  const sql = historySql();
  assert.strictEqual(HISTORY_MIN_DETECTIONS, 5);
  assert.match(sql, /i\.detection_count >= \$3/);
  assert.match(sql, /NOT COALESCE\(\(i\.distinct_days_seen >= 7 AND/);
  assert.ok(!/heat_source_class/.test(sql));
});
b('SQL: 188 m buffer, polygons only, simplified', () => {
  const sql = historySql();
  assert.strictEqual(HISTORY_BUFFER_M, 188);
  assert.match(sql, /ST_Buffer\(i\.footprint::geography, 188,/);
  assert.match(sql, /ST_CollectionExtract\(/);
  assert.match(sql, /ST_SimplifyPreserveTopology\(/);
});

b('SQL: city is the nearest district’s own province, city_id only as fallback', () => {
  const sql = historySql();
  assert.match(sql, /COALESCE\(d\.province_name, c\.name\) AS city/);
  assert.match(sql, /SELECT td\.name, td\.province_name FROM turkey_districts td/);
  assert.ok(!/c\.name AS city/.test(sql));
});
b('SQL: footprint coordinates at 4 decimals (~11 m)', () => {
  assert.strictEqual(HISTORY_GEOMETRY_DECIMALS, 4);
  assert.match(historySql(), /\),\s*4\s*\) AS geometry/);
});
b('province names: İçel is shown as Mersin, others unchanged', () => {
  assert.strictEqual(displayProvinceName('İçel'), 'Mersin');
  assert.strictEqual(displayProvinceName('Icel'), 'Mersin');
  assert.strictEqual(displayProvinceName('Mersin'), 'Mersin');
  assert.strictEqual(displayProvinceName('Şanlıurfa'), 'Şanlıurfa');
  assert.strictEqual(displayProvinceName(null), null);
});
b('server: compression() is mounted before /api/history', () => {
  const server = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf8');
  const compress = server.indexOf('app.use(compression(');
  const history = server.indexOf("app.use('/api/history'");
  assert.ok(compress > 0 && history > 0 && compress < history);
});
b('history cache key is v3 and separates polygon from fallback answers', () => {
  const route = readFileSync(join(__dirname, '..', 'src', 'routes', 'history.ts'), 'utf8');
  assert.match(route, /`history:v3:\$\{usePolygons \? 'p' : 'c'\}:\$\{range\.from\}:\$\{range\.to\}`/);
});
b('SQL with polygons (015): the province of the centre, and a district of that province', () => {
  const sql = historySql(true);
  assert.match(sql, /WHERE tc\.id = province_for_point\(i\.centroid\)/);
  assert.match(sql, /WHERE td2\.province_id = tc\.id/);
});

const row = {
  id: '3725',
  city: 'Antalya',
  district: 'Kepez',
  date_start: '2026-09-07',
  date_end: '2026-09-09',
  first_detected_at: new Date('2026-09-07T10:00:00Z'),
  last_detected_at: new Date('2026-09-09T11:30:00Z'),
  detection_count: 533,
  max_frp_mw: '3422.37',
  lng: '30.712345678',
  lat: '36.98765432',
  geometry: '{"type":"MultiPolygon","coordinates":[[[[30.7,36.9],[30.71,36.9],[30.71,36.91],[30.7,36.9]]]]}',
};

b('feature: contract shape', () => {
  const f = toHistoryFeature(row);
  assert.strictEqual(f.type, 'Feature');
  assert.strictEqual(f.id, 3725);
  assert.strictEqual(f.geometry.type, 'MultiPolygon');
  const p = f.properties;
  assert.strictEqual(p.city, 'Antalya');
  assert.strictEqual(p.district, 'Kepez');
  assert.strictEqual(p.district_basis, 'nearest_district_center');
  assert.strictEqual(p.date_start, '2026-09-07');
  assert.strictEqual(p.date_end, '2026-09-09');
  assert.deepStrictEqual(p.restoration_updates, []);
  assert.deepStrictEqual(p.campaigns, []);
});
b('feature: area_ha is null, never a buffer area', () => assert.strictEqual(toHistoryFeature(row).properties.area_ha, null));
b('feature: detections, duration and peak FRP', () => {
  const p = toHistoryFeature(row).properties;
  assert.strictEqual(p.detection_count, 533);
  assert.strictEqual(p.duration_hours, 49.5);
  assert.strictEqual(p.max_frp_mw, 3422.4);
});
b('feature: NASA FIRMS source, footprint geometry kind', () => {
  const p = toHistoryFeature(row).properties;
  assert.strictEqual(p.source, 'NASA FIRMS');
  assert.strictEqual(p.source_url, FIRMS_MAP_URL);
  assert.strictEqual(p.geometry_kind, 'satellite_heat_detection_footprint');
  assert.deepStrictEqual(p.centroid, [30.71235, 36.98765]);
});
b('feature: a fallback "İçel" becomes "Mersin"', () => {
  assert.strictEqual(toHistoryFeature({ ...row, city: 'İçel', district: null }).properties.city, 'Mersin');
});
b('feature: null FRP and missing district stay null', () => {
  const p = toHistoryFeature({ ...row, max_frp_mw: null, district: null }).properties;
  assert.strictEqual(p.max_frp_mw, null);
  assert.strictEqual(p.district_basis, null);
});
b('collection: drops features without geometry, carries provenance', () => {
  const fc = toHistoryCollection([row, { ...row, id: 1, geometry: null }], { from: '2026-09-01', to: '2026-09-30' }, '2026-08-05');
  assert.strictEqual(fc.type, 'FeatureCollection');
  assert.strictEqual(fc.features.length, 1);
  assert.strictEqual(fc.metadata.data_available_from, '2026-08-05');
  assert.strictEqual(fc.metadata.source.provider, 'NASA FIRMS');
  assert.match(fc.metadata.source.attribution, /Fire Information for Resource Management System \(FIRMS\)/);
  assert.ok(!/EFFIS|Copernicus/.test(JSON.stringify(fc)));
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
