import { GeoTIFFImage, fromUrl } from 'geotiff';

/**
 * What the ground is around a detection, from ESA WorldCover 2021 (10 m).
 *
 * Attribution required by CC BY 4.0: "© ESA WorldCover project 2021 /
 * Contains modified Copernicus Sentinel data (2021) processed by ESA
 * WorldCover consortium".
 *
 * Measured 2026-11-08: of the 25 strong events on the map, 23 sat on
 * cropland (stubble burning season), one on the Iskenderun industrial zone,
 * one on forest. See OLAY-OLCUM-RAPORU.md in the app repo.
 */

export type LandCover = 'natural' | 'agriculture' | 'built' | 'other' | 'unknown';
export type LandCoverShares = Record<string, number>;

/** VIIRS pixels are 375 m and a cluster centroid can sit a pixel off. */
export const LAND_COVER_RADIUS_M = 750;
export const AGRICULTURE_MIN_SHARE = 35;
export const BUILT_MIN_SHARE = 30;
export const WOODY_OVERRIDE_SHARE = 35;
export const NATURAL_MIN_SHARE = 60;

const CLASS_NAMES: Record<number, string> = {
  10: 'tree',
  20: 'shrub',
  30: 'grass',
  40: 'crop',
  50: 'built',
  60: 'bare',
  70: 'snow',
  80: 'water',
  90: 'wetland',
  95: 'mangrove',
  100: 'moss',
};

/**
 * Cropland wins a mixed window unless there is real woodland in it: a
 * stubble fire next to a hedge is still a stubble fire, a burn at a forest
 * edge is not. Grass alone is not enough to outvote crops, because
 * WorldCover often maps Anatolian fallow as grass.
 */
export function classifyLandCover(s: LandCoverShares): LandCover {
  const share = (k: string) => s[k] ?? 0;
  const woody = share('tree') + share('shrub');
  const natural = woody + share('grass') + share('wetland') + share('mangrove') + share('moss');
  if (share('built') >= BUILT_MIN_SHARE) return 'built';
  if (share('crop') >= AGRICULTURE_MIN_SHARE && woody < WOODY_OVERRIDE_SHARE) return 'agriculture';
  if (natural >= NATURAL_MIN_SHARE) return 'natural';
  return 'other';
}

export function worldCoverTileName(lat: number, lng: number): string {
  const la = Math.floor(lat / 3) * 3;
  const ln = Math.floor(lng / 3) * 3;
  return `N${String(la).padStart(2, '0')}E${String(ln).padStart(3, '0')}`;
}

export function worldCoverUrl(tile: string): string {
  return `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${tile}_Map.tif`;
}

export function sharesFromPixels(pixels: ArrayLike<number>): LandCoverShares {
  const counts: Record<string, number> = {};
  for (let i = 0; i < pixels.length; i++) {
    const name = CLASS_NAMES[pixels[i]];
    if (name) counts[name] = (counts[name] ?? 0) + 1;
  }
  const out: LandCoverShares = {};
  for (const [k, n] of Object.entries(counts)) out[k] = Math.round((n / pixels.length) * 100);
  return out;
}

export type LandCoverSampler = (lat: number, lng: number) => Promise<LandCoverShares>;

const images = new Map<string, Promise<GeoTIFFImage>>();

function imageFor(lat: number, lng: number): Promise<GeoTIFFImage> {
  const tile = worldCoverTileName(lat, lng);
  let image = images.get(tile);
  if (!image) {
    image = fromUrl(worldCoverUrl(tile)).then((tiff) => tiff.getImage());
    images.set(tile, image);
    // A failed open must not be remembered.
    image.catch(() => images.delete(tile));
  }
  return image;
}

/** Throws on network trouble; the caller retries next tick. */
export const sampleWorldCover: LandCoverSampler = async (lat, lng) => {
  const image = await imageFor(lat, lng);
  const [originX, originY] = image.getOrigin();
  const [resX, resY] = image.getResolution();
  const dLat = LAND_COVER_RADIUS_M / 111_320;
  const dLng = LAND_COVER_RADIUS_M / (111_320 * Math.cos((lat * Math.PI) / 180));
  const x0 = Math.max(0, Math.floor((lng - dLng - originX) / resX));
  const x1 = Math.min(image.getWidth(), Math.ceil((lng + dLng - originX) / resX));
  const y0 = Math.max(0, Math.floor((lat + dLat - originY) / resY));
  const y1 = Math.min(image.getHeight(), Math.ceil((lat - dLat - originY) / resY));
  const rasters = await image.readRasters({ window: [x0, y0, x1, y1] });
  return sharesFromPixels((rasters as unknown as ArrayLike<number>[])[0]);
};

/**
 * The SQL form of the rule for the main layer and fire alerts: natural
 * ground or a news-confirmed fire. Not classified yet stays in: a real fire
 * must not vanish because a lookup failed.
 */
export function naturalOrConfirmedSql(alias: string): string {
  return `(${alias}.land_cover IS NULL OR ${alias}.land_cover IN ('natural', 'unknown') OR ${alias}.news_verified_id IS NOT NULL)`;
}
