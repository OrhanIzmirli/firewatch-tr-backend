// Region keys shared with the Flutter client.
//
// This is a deliberate line-for-line port of _bboxRegionKey in
// lib/models/fire_point.dart. The bounding boxes overlap, so the ORDER of the
// checks is part of the definition — reordering them silently changes which
// region a coordinate resolves to. If the client copy changes, change this one
// in the same commit or targeted alerts will be delivered to the wrong people.

import { turkishToLower } from './turkishText';

export const REGION_KEYS = [
  'ege',
  'akdeniz',
  'marmara',
  'karadeniz',
  'ic_anadolu',
  'dogu_anadolu',
  'guneydogu_anadolu',
] as const;

export type RegionKey = (typeof REGION_KEYS)[number];

export function isRegionKey(value: unknown): value is RegionKey {
  return typeof value === 'string' && (REGION_KEYS as readonly string[]).includes(value);
}

/**
 * Folds a Turkish region name to a comparable form: 'İç Anadolu', 'Ic Anadolu'
 * and 'iç anadolu' all become 'ic anadolu'. Needed because turkey_cities.region
 * stores display names with diacritics while REGIONS[].name in the risk job
 * uses ASCII spellings.
 */
function foldRegionName(value: string): string {
  return turkishToLower(value)
    .replace(/ç/g, 'c')
    .replace(/ğ/g, 'g')
    .replace(/ı/g, 'i')
    .replace(/ö/g, 'o')
    .replace(/ş/g, 's')
    .replace(/ü/g, 'u')
    .replace(/\s+/g, ' ')
    .trim();
}

const REGION_NAME_TO_KEY: Record<string, RegionKey> = {
  'ege': 'ege',
  'akdeniz': 'akdeniz',
  'marmara': 'marmara',
  'karadeniz': 'karadeniz',
  'ic anadolu': 'ic_anadolu',
  'dogu anadolu': 'dogu_anadolu',
  'guneydogu anadolu': 'guneydogu_anadolu',
};

/**
 * Maps a human-readable region name (turkey_cities.region, or the risk job's
 * REGIONS[].name/display) to the canonical key. Returns null for anything
 * unrecognised so callers can fall back to the coordinate boxes.
 */
export function regionKeyForRegionName(name: string | null | undefined): RegionKey | null {
  if (!name) return null;
  return REGION_NAME_TO_KEY[foldRegionName(name)] ?? null;
}

/** Returns the region key for a coordinate, or null when it falls outside all boxes. */
export function regionKeyForCoordinates(lat: number, lng: number): RegionKey | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  if (lng >= 26.0 && lng <= 30.5 && lat >= 36.5 && lat <= 39.5) return 'ege';
  if (lng >= 29.5 && lng <= 37.0 && lat >= 36.0 && lat <= 38.5) return 'akdeniz';
  if (lng >= 26.0 && lng <= 32.0 && lat >= 39.5 && lat <= 42.0) return 'marmara';
  if (lat >= 40.5 && lat <= 42.2) return 'karadeniz';
  if (lng >= 30.0 && lng <= 37.5 && lat >= 38.0 && lat <= 41.0) return 'ic_anadolu';
  if (lng >= 37.5 && lng <= 44.8 && lat >= 38.0 && lat <= 42.0) return 'dogu_anadolu';
  if (lng >= 36.0 && lng <= 44.8 && lat >= 36.0 && lat <= 38.5) return 'guneydogu_anadolu';

  return null;
}
