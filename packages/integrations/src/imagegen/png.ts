import { deflateSync } from "node:zlib";

/**
 * Just enough PNG to draw a placeholder: 8-bit truecolour, no interlacing, no
 * palette, no alpha.
 *
 * Written out by hand rather than pulled from a library because the mock
 * adapter must work in a bare `vitest` run with no native module and no
 * network — the same rule every mock in this package follows. The real
 * drawing, with fonts and a logo, is Satori and Sharp in `packages/core`;
 * nothing here is meant to grow into that.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The standard CRC-32 table, built once. `chunk` needs one per chunk and PNG mandates it. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `"#0969ca"` → `{ r: 9, g: 105, b: 202 }`. Throws on anything that is not a six-digit hex colour. */
export function parseHexColour(hex: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) throw new Error(`Not a six-digit hex colour: ${JSON.stringify(hex)}`);
  const value = Number.parseInt(match[1]!, 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

export interface BandedImage {
  width: number;
  height: number;
  ground: Rgb;
  band: Rgb;
  /** The band's top and bottom as fractions of the height, e.g. `[0.62, 0.78]`. */
  bandRows: [number, number];
}

/**
 * A flat field with one lighter horizontal band, encoded as a PNG.
 *
 * Every row is written with filter type 0 (none) — the pixels are two colours,
 * so deflate flattens them to a couple of kilobytes whatever the filter, and
 * "none" keeps this readable.
 */
export function encodeBandedPng(image: BandedImage): Buffer {
  const { width, height, ground, band } = image;
  const bandTop = Math.round(image.bandRows[0] * height);
  const bandBottom = Math.round(image.bandRows[1] * height);

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  const groundRow = solidRow(width, ground);
  const bandRow = solidRow(width, band);
  for (let y = 0; y < height; y++) {
    const offset = y * stride;
    raw[offset] = 0; // filter: none
    (y >= bandTop && y < bandBottom ? bandRow : groundRow).copy(raw, offset + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function solidRow(width: number, colour: Rgb): Buffer {
  const row = Buffer.alloc(width * 3);
  for (let x = 0; x < width; x++) {
    row[x * 3] = colour.r;
    row[x * 3 + 1] = colour.g;
    row[x * 3 + 2] = colour.b;
  }
  return row;
}
