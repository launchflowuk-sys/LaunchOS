import {
  assertPubliclyFetchable,
  type CapturedScreenshot,
  MAX_SCREENSHOT_BYTES,
  ScreenshotFailed,
  ScreenshotInput,
  type ScreenshotAdapter,
} from "./types.js";

/**
 * ScreenshotOne, which renders the page on their side and returns the image.
 *
 * A hosted renderer rather than a headless browser in our own worker: Chromium
 * in the worker image would add roughly 400MB to a deployment on a box that
 * has already run out of disk once, and it would put page rendering — the
 * least trustworthy thing a server can do — inside the process that holds the
 * database connection.
 */
export const SCREENSHOTONE_ENDPOINT = "https://api.screenshotone.com/take";

/** Thirty seconds. A slow site is common; a site that takes longer is a capture worth abandoning. */
export const SCREENSHOT_TIMEOUT_MS = 30_000;

export interface ScreenshotOneConfig {
  readonly accessKey: string;
}

export interface ScreenshotHttpOptions {
  /** Injected in tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** Injected in tests so nothing ever reaches the real provider. */
  endpoint?: string | undefined;
}

export class ScreenshotOneAdapter implements ScreenshotAdapter {
  readonly name = "screenshotone" as const;

  constructor(
    private readonly config: ScreenshotOneConfig,
    private readonly options: ScreenshotHttpOptions = {},
  ) {}

  async capture(input: ScreenshotInput): Promise<CapturedScreenshot> {
    const v = ScreenshotInput.parse(input);
    const target = assertPubliclyFetchable(v.url);

    const endpoint = this.options.endpoint ?? SCREENSHOTONE_ENDPOINT;
    const timeoutMs = this.options.timeoutMs ?? SCREENSHOT_TIMEOUT_MS;
    const fetchImpl = this.options.fetch ?? fetch;

    const query = new URLSearchParams({
      access_key: this.config.accessKey,
      url: target.toString(),
      viewport_width: String(v.width),
      viewport_height: String(v.height),
      format: "png",
      // The thumbnail is the page as a visitor first sees it, so: no full
      // page, and give the cookie banner a chance to be dismissed rather than
      // shipping twenty screenshots of a consent dialog.
      full_page: "false",
      block_cookie_banners: "true",
      block_ads: "true",
      // Their cache, not ours — a repeat capture within the day costs nothing
      // and the refresh job is daily.
      cache: "true",
      cache_ttl: "86400",
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}?${query.toString()}`, { signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ScreenshotFailed("unreachable", `no answer within ${timeoutMs} ms`);
      }
      throw new ScreenshotFailed("unreachable", error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The body carries their reason, and it is the useful half of the
      // failure — "the page returned 403" rather than "500".
      const detail = await response.text().catch(() => "");
      throw new ScreenshotFailed("refused", `${response.status} ${detail.slice(0, 200)}`.trim());
    }

    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!mime.startsWith("image/")) {
      throw new ScreenshotFailed("not_an_image", `answered with ${mime || "no content type"}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new ScreenshotFailed("not_an_image", "answered with an empty body");
    if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new ScreenshotFailed(
        "too_large",
        `${bytes.byteLength} bytes is over the ${MAX_SCREENSHOT_BYTES} byte ceiling`,
      );
    }

    return { bytes, mime, width: v.width, height: v.height, adapter: this.name };
  }
}
