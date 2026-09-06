/**
 * Photographing a live page with the browser this process already has.
 *
 * A launch screenshot is the one thing a case study cannot be written without,
 * and taking one needs exactly what the document engine next door needs: a
 * headless Chromium. So it borrows that one, through the same `PdfRenderer`
 * handle, rather than bringing a second browser into the worker's image. Two
 * Chromiums in one container is 240 MB of resident memory and two things to
 * remember to close on SIGTERM; there is no version of this worth having.
 *
 * The trade that comes with it is worth stating plainly. `chromium.ts` argues
 * for `--no-sandbox` on the grounds that the browser only ever renders HTML
 * this codebase generated. A screenshot breaks that: it loads a real page off
 * the internet. Three things hold the line instead.
 *
 * - **The caller vets the URL.** `apps/worker/src/jobs/case-study-launch.ts`
 *   puts every address through `isBlockedTarget` from `@launchos/integrations`
 *   — http(s) only, no loopback, no RFC 1918, no link-local — before it
 *   reaches here. That guard lives at the call site rather than in this
 *   package because `channels` may not import `integrations`; this module is
 *   a peripheral and takes the URL it is given.
 * - **A throwaway context per capture.** `browser.newContext()` gives the page
 *   its own cookie jar, storage and cache, discarded when the capture ends, so
 *   nothing a captured site sets can be read by the next capture — or by a
 *   document render sharing the browser.
 * - **No downloads, and a short clock.** Downloads are refused outright and
 *   the whole capture is bounded by `CAPTURE_TIMEOUT_MS`, so a page that hangs
 *   costs one job, not the queue.
 */

/** The two shots a case study carries, and the sizes they are taken at. */
export const SCREENSHOT_VIEWPORTS = {
  /** A laptop, not a 4K monitor: this is the width the design was drawn for. */
  desktop: { width: 1440, height: 900 },
  /** An iPhone 15-ish viewport — the phone most of Shoji's clients' visitors hold. */
  mobile: { width: 390, height: 844 },
} as const;

export type ScreenshotViewport = keyof typeof SCREENSHOT_VIEWPORTS;
export const SCREENSHOT_VIEWPORT_KEYS = Object.keys(SCREENSHOT_VIEWPORTS) as readonly ScreenshotViewport[];

/**
 * How long one capture may take, end to end.
 *
 * Longer than a PDF render because this one waits on somebody else's server,
 * their fonts and their images; shorter than a person would wait, because a
 * site that cannot draw itself in twenty seconds has a problem the screenshot
 * is not going to fix.
 */
export const CAPTURE_TIMEOUT_MS = 20_000;

/**
 * The pause between "the network went quiet" and the shutter.
 *
 * Almost every site Shoji builds fades its hero in. Without this the picture
 * is of a half-transparent page — technically loaded, visibly wrong.
 */
export const CAPTURE_SETTLE_MS = 1_200;

export interface CaptureScreenshotInput {
  /** An absolute http(s) URL. **The caller must have vetted it** — see above. */
  url: string;
  /** Which of the two sizes. `desktop` unless said otherwise. */
  viewport?: ScreenshotViewport;
  /**
   * The whole scrolling page rather than the first screen. Off by default: a
   * case study card wants the fold, and a full-page shot of a long landing
   * page is a 6 MB ribbon nobody looks at.
   */
  fullPage?: boolean;
  timeoutMs?: number;
}

/** What a capture answers with: the bytes, and the size they were taken at. */
export interface Screenshot {
  bytes: Uint8Array<ArrayBuffer>;
  mime: "image/png";
  viewport: ScreenshotViewport;
  width: number;
  height: number;
}

/** The page could not be reached, drawn, or photographed. */
export class ScreenshotFailed extends Error {
  constructor(
    readonly url: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ScreenshotFailed";
  }
}

/** Every PNG starts with the same eight bytes. Cheap proof the bytes are one. */
export const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function looksLikePng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PNG_MAGIC.length) return false;
  return PNG_MAGIC.every((byte, index) => bytes[index] === byte);
}
