/**
 * Wording of push notifications and the report/satellite match.
 *
 *   npm run test:alert-text
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { multipleDetectionsAlertText, riskAlertText } from '../src/services/alertText';
import { reportResultMessage, reportSatelliteMatchSql } from '../src/services/reportSatelliteMatch';

let failures = 0;
const b = (name: string, fn: () => void) => {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${(e as Error).message}`); }
};

b('risk alert reports the reading, never a fixed cause', () => {
  const t = riskAlertText({ regionDisplay: 'Ege', score: 72, temperature: 30.4, humidity: 41, windSpeed: 52.2 });
  assert.match(t.body, /72\/100/);
  assert.match(t.body, /30°C/);
  assert.match(t.body, /nem %41/);
  assert.match(t.body, /52 km\/sa/);
  assert.ok(!/Sıcaklık yüksek|nem düşük/.test(t.body));
});
b('multiple detections alert does not call them fires', () => {
  const t = multipleDetectionsAlertText('Akdeniz', 7);
  assert.ok(!/yangın tespit/i.test(t.title));
  assert.match(t.body, /Doğrulanmış yangın değildir/);
  assert.match(t.body, /112/);
});
b('the job uses the tested text', () => {
  const job = readFileSync(join(__dirname, '../src/jobs/riskCalculatorJob.ts'), 'utf8');
  assert.match(job, /riskAlertText\(/);
  assert.match(job, /multipleDetectionsAlertText\(/);
  assert.ok(!/Sıcaklık yüksek, nem düşük|Çoklu Yangın Tespiti/.test(job));
});
b('report match reads the table that has data, within a time window', () => {
  const sql = reportSatelliteMatchSql();
  assert.match(sql, /FROM fire_detections/);
  assert.match(sql, /acquired_at > now\(\) - make_interval\(hours => \$4\)/);
  const route = readFileSync(join(__dirname, '../src/routes/fires.ts'), 'utf8');
  assert.ok(!/COUNT\(\*\) as count FROM fires/.test(route), 'the empty fires table cannot match a report');
});
b('a match is never called verified', () => {
  for (const m of [true, false]) assert.ok(!/doğrulandı/i.test(reportResultMessage(m)));
  assert.match(reportResultMessage(true), /tek başına doğrulamaz/);
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
