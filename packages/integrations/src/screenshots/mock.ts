import { encodeBandedPng, parseHexColour, type Rgb } from "../imagegen/png.js";
import {
  assertPubliclyFetchable,
  type CapturedScreenshot,
  ScreenshotInput,
  type ScreenshotAdapter,
} from "./types.js";

/**
 * A recognisable placeholder, drawn in process.
 *
 * Six muted grounds rather than one, chosen by a hash of the URL, so a list of
 * twenty sites does not look like twenty copies of the same broken image and a
 * given site keeps the same colour between runs. Every one carries a lighter
 * band across the top third, which reads as a page header at thumbnail size
 * and makes the placeholder obviously deliberate.
 *
 * Like every mock in this package it is not pretty on purpose. A placeholder
 * that looked like a real screenshot would let a deployment run without a
 * capture provider for a month and nobody would ask why every site looks the
 * same; `adapter-guard.ts` says so at startup for the same reason.
 */
const GROUNDS = ["#243B53", "#3E4C59", "#2B4A3F", "#4A3B52", "#52483B", "#31455C"] as const;
const BAND_LIGHTEN = 0.22;
/** A page header occupies roughly the top fifth; at 120px tall that is a believable bar. */
const BAND_ROWS: [number, number] = [0.0, 0.2];

/** FNV-1a. Small, stable across runs, and there is nothing cryptographic here. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function lighten({ r, g, b }: Rgb, amount: number): Rgb {
  const up = (channel: number) => Math.round(channel + (255 - channel) * amount);
  return { r: up(r), g: up(g), b: up(b) };
}

export class MockScreenshotAdapter implements ScreenshotAdapter {
  readonly name = "mock" as const;
  /** Every URL it was asked for, so a test can read what would have been captured. */
  readonly calls: { url: string; width: number; height: number }[] = [];
  /** Set to make the next `capture` throw, for the failure-path tests. */
  failNext: Error | null = null;

  async capture(input: ScreenshotInput): Promise<CapturedScreenshot> {
    const v = ScreenshotInput.parse(input);
    // The mock applies the same URL rule as a real adapter: a test that passes
    // `http://localhost` must fail here too, or the guard is only enforced in
    // production and is therefore never exercised.
    const url = assertPubliclyFetchable(v.url);

    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }

    this.calls.push({ url: v.url, width: v.width, height: v.height });
    // Keyed on the host, not the full URL: two pages of one site should look
    // like the same site.
    const ground = parseHexColour(GROUNDS[hash(url.hostname) % GROUNDS.length]!);
    const bytes = encodeBandedPng({
      width: v.width,
      height: v.height,
      ground,
      band: lighten(ground, BAND_LIGHTEN),
      bandRows: BAND_ROWS,
    });
    return { bytes, mime: "image/png", width: v.width, height: v.height, adapter: this.name };
  }
}
