import axios from 'axios';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { NEWS_USER_AGENT } from '../config/newsSources';

/**
 * Satellite picture of a province on a given day, from NASA GIBS, kept on
 * this server so the app never calls NASA with a reader's IP. MODIS is used
 * because NASA states its CC0 status plainly.
 */
const LAYERS = ['MODIS_Terra_CorrectedReflectance_TrueColor', 'MODIS_Aqua_CorrectedReflectance_TrueColor'];
const WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
/** GIBS answers 200 with an all-black JPEG of about 1 KB when it has no data. */
export const MIN_IMAGE_BYTES = 8_000;
const CACHE_DIR = path.join(os.tmpdir(), 'firewatch-news-thumbs');

export function thumbUrl(lat: number, lng: number, date: string, layer: string): string {
  const bbox = [lat - 0.65, lng - 1.3, lat + 0.65, lng + 1.3].map((v) => v.toFixed(2)).join(',');
  const q = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.3.0', REQUEST: 'GetMap', LAYERS: layer, CRS: 'EPSG:4326',
    BBOX: bbox, WIDTH: '640', HEIGHT: '320', FORMAT: 'image/jpeg', TIME: date,
  });
  return `${WMS}?${q}`;
}

/** The fuller of the two images: a swath gap or a blank day compresses to fewer bytes. */
export function pickFullest(images: (Buffer | null)[]): Buffer | null {
  let best: Buffer | null = null;
  for (const image of images) {
    if (image && image.length >= MIN_IMAGE_BYTES && (!best || image.length > best.length)) best = image;
  }
  return best;
}

async function download(url: string): Promise<Buffer | null> {
  try {
    const r = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 20000, headers: { 'User-Agent': NEWS_USER_AGENT } });
    return String(r.headers['content-type']).startsWith('image/jpeg') ? Buffer.from(r.data) : null;
  } catch {
    return null;
  }
}

const inFlight = new Map<string, Promise<Buffer | null>>();

export async function provinceThumb(slug: string, lat: number, lng: number, date: string): Promise<Buffer | null> {
  const file = path.join(CACHE_DIR, `${slug}-${date}.jpg`);
  try {
    return await fs.readFile(file);
  } catch {
    // not cached yet
  }
  const running = inFlight.get(file);
  if (running) return running;
  const job = (async () => {
    const best = pickFullest(await Promise.all(LAYERS.map((l) => download(thumbUrl(lat, lng, date, l)))));
    if (best) {
      await fs.mkdir(CACHE_DIR, { recursive: true });
      await fs.writeFile(file, best);
    }
    return best;
  })();
  inFlight.set(file, job);
  try {
    return await job;
  } finally {
    inFlight.delete(file);
  }
}
