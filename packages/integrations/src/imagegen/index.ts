import { FalImageGenAdapter } from "./fal.js";
import { MockImageGenAdapter } from "./mock.js";
import { OpenAiImageGenAdapter } from "./openai.js";
import type { ImageGenHttpOptions } from "./request.js";
import type { ImageGenAdapter } from "./types.js";

export * from "./types.js";
export * from "./cost.js";
export { IMAGEGEN_TIMEOUT_MS, sniffImageMime, type ImageGenHttpOptions } from "./request.js";
export { MockImageGenAdapter, MOCK_IMAGE_GROUND, MOCK_IMAGE_BAND } from "./mock.js";
export { encodeBandedPng, parseHexColour, type BandedImage, type Rgb } from "./png.js";
export { OpenAiImageGenAdapter, OPENAI_IMAGES_ENDPOINT, OPENAI_IMAGE_MODEL, type OpenAiImageGenConfig } from "./openai.js";
export { FalImageGenAdapter, FAL_FLUX_SCHNELL_ENDPOINT, FAL_IMAGE_MODEL, type FalImageGenConfig } from "./fal.js";

/** The one variable that selects a generator. `adapter-guard.ts` names anything else it finds here. */
export const IMAGEGEN_ADAPTER_VARIABLE = "IMAGEGEN_ADAPTER";

export const IMAGEGEN_ADAPTER_NAMES = ["mock", "openai", "fal"] as const;

/** The key each real generator needs. A name without its key is the downgrade the guard refuses. */
export const IMAGEGEN_ENV_KEYS = { openai: "OPENAI_API_KEY", fal: "FAL_KEY" } as const;

function trimmedOrUnset(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Selection is **by name**, not by credential, which is the one place this
 * factory differs from `createSocialPublisherFromEnv` and
 * `createAdsAdapterFromEnv` next door.
 *
 * Those two go live the moment their keys appear, because publishing to a page
 * you own costs nothing. This one spends money per call, so an `OPENAI_API_KEY`
 * that arrives for some other reason must not quietly start drawing pictures
 * at fourpence a go. Saying `IMAGEGEN_ADAPTER=openai` is how someone says they
 * meant it.
 *
 * A name with its key missing builds the mock rather than throwing — branded
 * templates still work, so a lost key must not take content generation down —
 * and `resolveImageGen` in `adapter-guard.ts` refuses that environment in
 * production, so it cannot go unnoticed either.
 */
export function createImageGenAdapterFromEnv(env: NodeJS.ProcessEnv, options: ImageGenHttpOptions = {}): ImageGenAdapter {
  const requested = trimmedOrUnset(env[IMAGEGEN_ADAPTER_VARIABLE]);
  if (requested === "openai") {
    const apiKey = trimmedOrUnset(env[IMAGEGEN_ENV_KEYS.openai]);
    if (apiKey) return new OpenAiImageGenAdapter({ apiKey }, options);
  } else if (requested === "fal") {
    const apiKey = trimmedOrUnset(env[IMAGEGEN_ENV_KEYS.fal]);
    if (apiKey) return new FalImageGenAdapter({ apiKey }, options);
  }
  return new MockImageGenAdapter();
}
