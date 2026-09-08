import { z } from "zod";

/**
 * A picture of a website as it looks right now.
 *
 * Thumbnails only. The product shows these at about 480px wide in a list, and
 * nothing else consumes them, so nothing here offers full-page capture, PDF or
 * a device frame — each of those is a bigger, slower, more expensive request
 * and none of them has a caller.
 */

export const SCREENSHOT_WIDTH = 960;
export const SCREENSHOT_HEIGHT = 600;

/**
 * A hard ceiling on what will be stored, because these rows live in Postgres
 * (see `site_screenshots`) and an unbounded blob column is how a database
 * quietly becomes a filesystem. A 960×600 PNG of a normal page is comfortably
 * under this; anything over it is a capture that has gone wrong.
 */
export const MAX_SCREENSHOT_BYTES = 2_000_000;

export const ScreenshotInput = z.object({
  /** The page to photograph. Must be http(s); a capture never follows anything else. */
  url: z.string().url(),
  width: z.number().int().min(320).max(1920).default(SCREENSHOT_WIDTH),
  height: z.number().int().min(200).max(1200).default(SCREENSHOT_HEIGHT),
});
export type ScreenshotInput = z.input<typeof ScreenshotInput>;

export interface CapturedScreenshot {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /** Which adapter produced it, so the UI can say "placeholder" honestly. */
  readonly adapter: string;
}

export interface ScreenshotAdapter {
  readonly name: string;
  capture(input: ScreenshotInput): Promise<CapturedScreenshot>;
}

/**
 * A capture that failed for a reason worth showing a person, rather than a
 * stack trace. The site list renders `reason` under the thumbnail slot.
 */
export class ScreenshotFailed extends Error {
  constructor(
    readonly reason: "unreachable" | "refused" | "too_large" | "not_an_image" | "bad_url",
    message: string,
  ) {
    super(message);
    this.name = "ScreenshotFailed";
  }
}

/**
 * Only http(s), and never a private address.
 *
 * A site's `primary_url` is typed by a person, and this function is what stops
 * that field being pointed at `http://169.254.169.254/` or `http://localhost:5432`
 * and turning a screenshot job into a request the server makes to its own
 * network on someone else's behalf. The real adapters send the URL to a third
 * party that does its own fetching, but the mock and any future in-process
 * capture would not, and the rule belongs with the input rather than with one
 * implementation of it.
 */
const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?|.*\.local)$|^\[?(fc|fd)/i;

export function assertPubliclyFetchable(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ScreenshotFailed("bad_url", `"${url}" is not a URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ScreenshotFailed("bad_url", `${parsed.protocol} is not a website address.`);
  }
  if (PRIVATE_HOST.test(parsed.hostname)) {
    throw new ScreenshotFailed("bad_url", `${parsed.hostname} is a private address and will not be fetched.`);
  }
  return parsed;
}
