/**
 * Removes metadata from report photos without decoding them, so the pixels
 * are untouched and no native image library is needed. Written as an
 * allowlist: anything not known to be needed to draw the image goes.
 *
 * JPEG: only the EXIF orientation survives, rewritten as a minimal block,
 * because phones store photos rotated and rely on it. Bytes after the end of
 * the image are dropped too: phones append extra images there, with their
 * own EXIF.
 *
 * lib/core/utils/image_metadata.dart is the same logic in the app.
 */
export class UnreadableImageError extends Error {}

const KEPT_PNG_CHUNKS = new Set([
  'IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'bKGD', 'hIST', 'pHYs',
]);
const KEPT_WEBP_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function startsWith(data: Buffer, text: string): boolean {
  return data.length >= text.length && data.subarray(0, text.length).toString('latin1') === text;
}

function readOrientation(payload: Buffer): number {
  const tiff = 6;
  if (payload.length < tiff + 8) return 1;
  const order = payload.subarray(tiff, tiff + 2).toString('latin1');
  if (order !== 'II' && order !== 'MM') return 1;
  const u16 = (at: number) => (order === 'II' ? payload.readUInt16LE(at) : payload.readUInt16BE(at));
  const u32 = (at: number) => (order === 'II' ? payload.readUInt32LE(at) : payload.readUInt32BE(at));
  if (u16(tiff + 2) !== 42) return 1;
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > payload.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > payload.length) return 1;
    if (u16(entry) !== 0x0112) continue;
    const value = u16(entry + 8);
    return value >= 1 && value <= 8 ? value : 1;
  }
  return 1;
}

function orientationSegment(orientation: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xe1, 0x00, 0x22]),
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from('MM', 'latin1'),
    Buffer.from([0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]),
  ]);
}

function keepJpegSegment(marker: number, payload: Buffer): boolean {
  if (marker >= 0xc0 && marker <= 0xcf) return true; // frames, Huffman and arithmetic tables
  if (marker === 0xdb || marker === 0xdc || marker === 0xdd) return true; // quantisation, lines, restart
  if (marker === 0xe0) return startsWith(payload, 'JFIF\0');
  if (marker === 0xe2) return startsWith(payload, 'ICC_PROFILE\0');
  if (marker === 0xee) return startsWith(payload, 'Adobe');
  return false;
}

function stripJpeg(b: Buffer): Buffer {
  const parts: Buffer[] = [b.subarray(0, 2)];
  let orientationSeen = false;
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new UnreadableImageError('bad JPEG marker');
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) throw new UnreadableImageError('truncated JPEG');
    const marker = b[i++];
    if (marker === 0xd9) {
      parts.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(parts);
    }
    if (marker === 0x00 || marker === 0xd8) throw new UnreadableImageError('bad JPEG marker');
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      parts.push(Buffer.from([0xff, marker]));
      continue;
    }
    if (i + 2 > b.length) throw new UnreadableImageError('truncated JPEG');
    const size = b.readUInt16BE(i);
    if (size < 2 || i + size > b.length) throw new UnreadableImageError('truncated JPEG');
    const segment = b.subarray(i - 2, i + size);
    const payload = b.subarray(i + 2, i + size);
    i += size;

    if (marker === 0xda) {
      parts.push(segment);
      const start = i;
      while (i < b.length) {
        if (b[i] === 0xff && i + 1 < b.length) {
          const next = b[i + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            i += 2;
            continue;
          }
          if (next !== 0xff) break;
        }
        i++;
      }
      parts.push(b.subarray(start, i));
      continue;
    }
    if (marker === 0xe1 && !orientationSeen && startsWith(payload, 'Exif\0\0')) {
      orientationSeen = true;
      const orientation = readOrientation(payload);
      if (orientation !== 1) parts.push(orientationSegment(orientation));
      continue;
    }
    if (keepJpegSegment(marker, payload)) parts.push(segment);
  }
  return Buffer.concat(parts); // image data cut short: no metadata can follow
}

function stripPng(b: Buffer): Buffer {
  const parts: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= b.length) {
    const size = b.readUInt32BE(i);
    const end = i + 12 + size;
    if (end > b.length) throw new UnreadableImageError('truncated PNG');
    const type = b.subarray(i + 4, i + 8).toString('latin1');
    if (KEPT_PNG_CHUNKS.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  throw new UnreadableImageError('truncated PNG');
}

function stripWebp(b: Buffer): Buffer {
  const parts: Buffer[] = [];
  let total = 4; // 'WEBP'
  let i = 12;
  while (i + 8 <= b.length) {
    const size = b.readUInt32LE(i + 4);
    if (i + 8 + size > b.length) throw new UnreadableImageError('truncated WebP');
    const end = Math.min(i + 8 + size + (size & 1), b.length);
    const type = b.subarray(i, i + 4).toString('latin1');
    if (KEPT_WEBP_CHUNKS.has(type)) {
      const chunk = Buffer.from(b.subarray(i, end));
      if (type === 'VP8X' && size >= 1) chunk[8] &= ~0x0c; // the EXIF and XMP flags
      parts.push(chunk);
      total += chunk.length;
    }
    i = end;
  }
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(total, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, ...parts]);
}

export function imageKind(b: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  return null;
}

/** Throws UnreadableImageError rather than pass on a photo it could not clean. */
export function stripImageMetadata(input: Buffer): Buffer {
  switch (imageKind(input)) {
    case 'jpeg': return stripJpeg(input);
    case 'png': return stripPng(input);
    case 'webp': return stripWebp(input);
    default: throw new UnreadableImageError('unsupported image');
  }
}
