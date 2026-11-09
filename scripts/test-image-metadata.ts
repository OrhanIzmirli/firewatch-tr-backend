/** npm run test:image-metadata — report photos lose their metadata. */
import assert from 'node:assert';
import { imageKind, stripImageMetadata, UnreadableImageError } from '../src/utils/imageMetadata';
import { scrubDataUri } from './scrub-report-photos';

let failed = 0;
function b(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}

const seg = (marker: number, payload: Buffer) =>
  Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
const SECRET = 'GPSLatitude37.123456';

/** An EXIF block with an orientation entry followed by "GPS" text. */
function exif(orientation: number, littleEndian = false): Buffer {
  const u16 = (v: number) => (littleEndian ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) => (littleEndian ? [v, 0, 0, 0] : [0, 0, 0, v]);
  return Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from(littleEndian ? 'II' : 'MM', 'latin1'),
    Buffer.from([...u16(42), ...u32(8), ...u16(1), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, 0, 0, 0, 0]),
    Buffer.from(SECRET, 'latin1'),
  ]);
}

const SCAN = Buffer.from([0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33]);
function jpeg(...middle: Buffer[]): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from('JFIF\0\x01\x01', 'latin1')),
    ...middle,
    seg(0xdb, Buffer.alloc(65, 7)),
    seg(0xc0, Buffer.alloc(9, 8)),
    seg(0xda, Buffer.alloc(8, 9)),
    SCAN,
    Buffer.from([0xff, 0xd9]),
  ]);
}

const has = (data: Buffer, text: string) => data.includes(Buffer.from(text, 'latin1'));

b('JPEG: GPS is gone and the image data is byte for byte the same', () => {
  const out = stripImageMetadata(jpeg(seg(0xe1, exif(1))));
  assert.ok(!has(out, SECRET));
  assert.ok(!has(out, 'Exif'));
  assert.ok(out.includes(SCAN));
  assert.ok(out.includes(seg(0xdb, Buffer.alloc(65, 7))));
  assert.strictEqual(out.subarray(-2).toString('hex'), 'ffd9');
});

for (const littleEndian of [false, true]) {
  b(`JPEG: a rotated photo keeps only its orientation (${littleEndian ? 'II' : 'MM'})`, () => {
    const out = stripImageMetadata(jpeg(seg(0xe1, exif(6, littleEndian))));
    assert.ok(!has(out, SECRET));
    assert.ok(has(out, 'Exif'));
    assert.ok(out.includes(Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6])));
  });
}

b('JPEG: cleaning is idempotent', () => {
  const once = stripImageMetadata(jpeg(seg(0xe1, exif(6))));
  assert.ok(stripImageMetadata(once).equals(once));
});

b('JPEG: XMP, comments, IPTC and MPF go; colour profile and Adobe stay', () => {
  const out = stripImageMetadata(jpeg(
    seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0' + SECRET, 'latin1')),
    seg(0xfe, Buffer.from(SECRET, 'latin1')),
    seg(0xed, Buffer.from('Photoshop 3.0\0' + SECRET, 'latin1')),
    seg(0xe2, Buffer.from('MPF\0' + SECRET, 'latin1')),
    seg(0xe2, Buffer.from('ICC_PROFILE\0abc', 'latin1')),
    seg(0xee, Buffer.from('Adobe-x', 'latin1'))
  ));
  assert.ok(!has(out, SECRET));
  assert.ok(has(out, 'ICC_PROFILE'));
  assert.ok(has(out, 'Adobe-x'));
});

b('JPEG: anything after the end of the image goes', () => {
  const out = stripImageMetadata(Buffer.concat([jpeg(), jpeg(seg(0xe1, exif(1)))]));
  assert.ok(!has(out, SECRET));
  assert.ok(out.equals(jpeg()));
});

b('JPEG: progressive scans survive', () => {
  const two = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xc2, Buffer.alloc(9, 8)),
    seg(0xda, Buffer.alloc(8, 9)), SCAN,
    seg(0xc4, Buffer.alloc(20, 3)),
    seg(0xda, Buffer.alloc(8, 5)), SCAN,
    Buffer.from([0xff, 0xd9]),
  ]);
  assert.ok(stripImageMetadata(two).equals(two));
});

b('malformed files are refused, not passed through', () => {
  assert.throws(() => stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 1])), UnreadableImageError);
  assert.throws(() => stripImageMetadata(Buffer.from([0xff, 0xd8, 0xff, 0x41, 0, 2, 0, 0, 5])), UnreadableImageError);
  assert.throws(() => stripImageMetadata(Buffer.from('not an image')), UnreadableImageError);
});

const chunk = (type: string, data: Buffer) => {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  return Buffer.concat([size, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

b('PNG: text and EXIF chunks go, trailing bytes too', () => {
  const clean = Buffer.concat([PNG_SIG, chunk('IHDR', Buffer.alloc(13)), chunk('IDAT', Buffer.alloc(5, 1)), chunk('IEND', Buffer.alloc(0))]);
  const dirty = Buffer.concat([
    PNG_SIG, chunk('IHDR', Buffer.alloc(13)),
    chunk('eXIf', Buffer.from(SECRET, 'latin1')),
    chunk('tEXt', Buffer.from(SECRET, 'latin1')),
    chunk('iTXt', Buffer.from(SECRET, 'latin1')),
    chunk('zTXt', Buffer.from(SECRET, 'latin1')),
    chunk('IDAT', Buffer.alloc(5, 1)),
    chunk('IEND', Buffer.alloc(0)),
    Buffer.from(SECRET, 'latin1'),
  ]);
  assert.ok(stripImageMetadata(dirty).equals(clean));
});

const riff = (...chunks: Buffer[]) => {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), size, body]);
};
const webChunk = (type: string, data: Buffer) => {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(type, 'latin1'), size, data, Buffer.alloc(data.length & 1)]);
};

b('WebP: EXIF and XMP go, the flags and the size follow', () => {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x0c | 0x10;
  const out = stripImageMetadata(riff(
    webChunk('VP8X', vp8x),
    webChunk('VP8 ', Buffer.alloc(7, 4)),
    webChunk('EXIF', Buffer.from(SECRET, 'latin1')),
    webChunk('XMP ', Buffer.from(SECRET, 'latin1'))
  ));
  assert.ok(!has(out, SECRET));
  assert.strictEqual(out[20], 0x10);
  assert.strictEqual(out.readUInt32LE(4), out.length - 8);
  assert.strictEqual(imageKind(out), 'webp');
});

b('stored photos: a dirty data URI is rewritten, a clean one left alone', () => {
  const dirty = 'data:image/jpeg;base64,' + jpeg(seg(0xe1, exif(1))).toString('base64');
  const first = scrubDataUri(dirty);
  assert.ok(first.changed);
  assert.ok(!Buffer.from(first.value.split(',')[1], 'base64').includes(Buffer.from(SECRET, 'latin1')));
  const second = scrubDataUri(first.value);
  assert.ok(!second.changed);
  assert.strictEqual(second.value, first.value);
  assert.ok(scrubDataUri('data:image/jpeg;base64,bm90').unreadable);
});

if (failed > 0) process.exit(1);
console.log('image metadata tests passed');
