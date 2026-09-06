import { z } from "zod";

/**
 * The three shapes an adapter will render. Square is what a Facebook,
 * Instagram or Business Profile post wants; the other two exist because
 * `gpt-image-1` bills by them and a caller that wants a portrait should not
 * have to crop one out of a square.
 */
export const IMAGEGEN_SIZES = ["1024x1024", "1024x1536", "1536x1024"] as const;

export type ImageGenSize = (typeof IMAGEGEN_SIZES)[number];

/** What a caller gets when it asks for nothing in particular. */
export const DEFAULT_IMAGEGEN_SIZE: ImageGenSize = "1024x1024";

/**
 * A prompt longer than this is a bug upstream, not a picture anyone wants:
 * `content_items.image_prompt` is a sentence or two written by the content
 * writer. Capping here rather than at the provider means the refusal names
 * our own limit instead of quoting somebody's API error back at Shoji.
 */
export const IMAGEGEN_PROMPT_MAX_CHARS = 4000;

/** Parsed by every adapter before it spends anything — the boundary this package owns. */
export const ImageGenInputSchema = z.object({
  prompt: z.string().trim().min(1).max(IMAGEGEN_PROMPT_MAX_CHARS),
  size: z.enum(IMAGEGEN_SIZES).optional(),
});

export type ImageGenInput = z.input<typeof ImageGenInputSchema>;

export interface GeneratedImage {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg";
  /**
   * An **estimate** of what this image cost, in whole pence — see
   * `cost.ts` for where each number comes from. It is what the monthly cap in
   * `renderContentImage` counts and what the post editor shows; it is not a
   * billed figure and will not reconcile to a provider invoice to the penny.
   */
  costPence: number;
  /** The provider's model id, recorded on the item so a picture can be traced back to what drew it. */
  model: string;
}

export type ImageGenAdapterName = "mock" | "openai" | "fal";

/**
 * The image generator behind AI mode. One call, no database, no storage: the
 * caller (`renderContentImage` in `packages/core`) is what turns these bytes
 * into a content asset, so an adapter can be swapped without touching how
 * pictures are stored or served.
 *
 * Nothing here is approval-gated. Generating an image sends nothing outward —
 * the `content_publish` approval is still the single gate on anything leaving
 * the building — so the bound on this is money, not permission, and money is
 * bounded by `IMAGEGEN_MONTHLY_CAP_PENCE`.
 */
export interface ImageGenAdapter {
  readonly name: ImageGenAdapterName;
  generate(input: ImageGenInput): Promise<GeneratedImage>;
}

/**
 * What the render job does with each differs, which is why they are separate:
 * `auth` and `content_policy` are for a human (fix the key, reword the prompt)
 * and retrying is pointless; `rate_limit` and `timeout` will probably clear on
 * the next run; `request_failed` is everything else.
 */
export type ImageGenRefusalCode = "auth" | "rate_limit" | "content_policy" | "timeout" | "request_failed";

/** Same reasoning as `social/errors.ts`: the detail ends up in a log line and in `content_items.last_error`. */
const MAX_DETAIL_CHARS = 400;

function truncate(detail: string): string {
  const flat = detail.replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
}

/**
 * A provider said no, classified so the caller can record `last_error` and
 * fall back to a branded template rather than crashing the agent run that
 * asked for the picture. Thrown for every non-2xx, for a timeout, and for a
 * 2xx whose body carries no image.
 */
export class ImageGenRefused extends Error {
  readonly provider: ImageGenAdapterName;
  readonly code: ImageGenRefusalCode;
  /** HTTP status of the failing reply, or 0 when nothing came back at all. */
  readonly status: number;
  readonly detail: string;

  constructor(provider: ImageGenAdapterName, status: number, detail: string, code: ImageGenRefusalCode = "request_failed") {
    const flat = truncate(detail);
    super(`${provider} image generation refused (HTTP ${status}${flat ? `: ${flat}` : ""})`);
    this.name = "ImageGenRefused";
    this.provider = provider;
    this.code = code;
    this.status = status;
    this.detail = flat;
  }
}

export function isImageGenRefused(error: unknown): error is ImageGenRefused {
  return error instanceof ImageGenRefused;
}

/** `"1536x1024"` → `{ width: 1536, height: 1024 }`, for the providers that want the pair. */
export function sizeDimensions(size: ImageGenSize): { width: number; height: number } {
  const [width, height] = size.split("x").map(Number) as [number, number];
  return { width, height };
}
