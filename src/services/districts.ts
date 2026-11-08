import pool from '../config/database';
import type { DistrictRef } from './placeMention';

let cached: Promise<DistrictRef[]> | null = null;

/** Every district, loaded once per process: the table changes only by migration. */
export function loadDistricts(): Promise<DistrictRef[]> {
  if (!cached) {
    cached = pool
      .query('SELECT id, name, province_id, province_name FROM turkey_districts')
      .then((r) => r.rows.map((d: any) => ({ id: d.id, name: d.name, provinceId: d.province_id, provinceName: d.province_name, lat: 0, lng: 0 })))
      .catch((error) => {
        cached = null;
        throw error;
      });
  }
  return cached;
}
