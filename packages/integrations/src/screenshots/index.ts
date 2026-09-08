import { MockScreenshotAdapter } from "./mock.js";
import { ScreenshotOneAdapter, type ScreenshotHttpOptions } from "./screenshotone.js";
import type { ScreenshotAdapter } from "./types.js";

export * from "./types.js";
export { MockScreenshotAdapter } from "./mock.js";
export {
  ScreenshotOneAdapter,
  SCREENSHOTONE_ENDPOINT,
  SCREENSHOT_TIMEOUT_MS,
  type ScreenshotOneConfig,
  type ScreenshotHttpOptions,
} from "./screenshotone.js";

/** The one variable that selects a capture provider. */
export const SCREENSHOT_ADAPTER_VARIABLE = "SCREENSHOT_ADAPTER";

export const SCREENSHOT_ADAPTER_NAMES = ["mock", "screenshotone"] as const;

/** The key each real provider needs. A name without its key is the downgrade the guard refuses. */
export const SCREENSHOT_ENV_KEYS = { screenshotone: "SCREENSHOTONE_ACCESS_KEY" } as const;

function trimmedOrUnset(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Selection is **by name**, like `createImageGenAdapterFromEnv` and for the
 * same reason: a capture costs money per call, so a key that arrives for some
 * other purpose must not quietly start photographing twenty websites a day.
 * Saying `SCREENSHOT_ADAPTER=screenshotone` is how someone says they meant it.
 *
 * A name with its key missing builds the mock rather than throwing — a lost
 * key must not take the websites list down over a picture — and the startup
 * guard names that environment so it cannot go unnoticed either.
 */
export function createScreenshotAdapterFromEnv(
  env: NodeJS.ProcessEnv,
  options: ScreenshotHttpOptions = {},
): ScreenshotAdapter {
  if (trimmedOrUnset(env[SCREENSHOT_ADAPTER_VARIABLE]) === "screenshotone") {
    const accessKey = trimmedOrUnset(env[SCREENSHOT_ENV_KEYS.screenshotone]);
    if (accessKey) return new ScreenshotOneAdapter({ accessKey }, options);
  }
  return new MockScreenshotAdapter();
}
