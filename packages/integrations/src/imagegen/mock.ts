import { encodeBandedPng, parseHexColour } from "./png.js";
import {
  DEFAULT_IMAGEGEN_SIZE,
  ImageGenInputSchema,
  sizeDimensions,
  type GeneratedImage,
  type ImageGenAdapter,
  type ImageGenInput,
  type ImageGenSize,
} from "./types.js";

/** The LaunchFlow accent, the same blue the marketing site and the branded templates use. */
export const MOCK_IMAGE_GROUND = "#0969ca";
/** A lighter band across the lower third, so a thumbnail is obviously a placeholder and not a broken load. */
export const MOCK_IMAGE_BAND = "#4d9ae4";
const MOCK_IMAGE_BAND_ROWS: [number, number] = [0.62, 0.78];

/** Built once per size and copied out, because the bytes never change and the encoded PNG is a few kilobytes. */
const cache = new Map<ImageGenSize, Buffer>();

/**
 * The image generator every test runs on, and what a deployment with no
 * `IMAGEGEN_ADAPTER` gets.
 *
 * Draws a flat brand-blue field with a lighter band, in process: no network,
 * no native dependency, no API key, `costPence: 0`. The bytes for a given size
 * are identical every time — a test can assert on them, and two runs of the
 * same job cannot produce two different pictures.
 *
 * It is deliberately not pretty. A mock that returned something plausible
 * would let a deployment run on it for a month without anyone noticing; this
 * one is recognisable at a glance in the post editor, which is the point.
 * `adapter-guard.ts` says the same thing in the startup log.
 */
export class MockImageGenAdapter implements ImageGenAdapter {
  readonly name = "mock" as const;
  /** Every prompt that reached it, so a test can read what would have been sent. */
  readonly calls: { prompt: string; size: ImageGenSize }[] = [];
  /** Set to make the next `generate` throw, for the failure-path tests. */
  failNext: Error | null = null;

  async generate(input: ImageGenInput): Promise<GeneratedImage> {
    const { prompt, size = DEFAULT_IMAGEGEN_SIZE } = ImageGenInputSchema.parse(input);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    this.calls.push({ prompt, size });
    return { bytes: Uint8Array.from(placeholder(size)), mime: "image/png", costPence: 0, model: "mock" };
  }
}

function placeholder(size: ImageGenSize): Buffer {
  const cached = cache.get(size);
  if (cached) return cached;
  const { width, height } = sizeDimensions(size);
  const png = encodeBandedPng({
    width,
    height,
    ground: parseHexColour(MOCK_IMAGE_GROUND),
    band: parseHexColour(MOCK_IMAGE_BAND),
    bandRows: MOCK_IMAGE_BAND_ROWS,
  });
  cache.set(size, png);
  return png;
}
