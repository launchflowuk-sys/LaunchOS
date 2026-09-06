import { z } from "zod";
import { FAL_IMAGE_COST_PENCE } from "./cost.js";
import { IMAGEGEN_TIMEOUT_MS, imageGenFetch, refusalFrom, sniffImageMime, type ImageGenHttpOptions } from "./request.js";
import {
  DEFAULT_IMAGEGEN_SIZE,
  ImageGenInputSchema,
  ImageGenRefused,
  sizeDimensions,
  type GeneratedImage,
  type ImageGenAdapter,
  type ImageGenInput,
} from "./types.js";

export const FAL_FLUX_SCHNELL_ENDPOINT = "https://fal.run/fal-ai/flux/schnell";
export const FAL_IMAGE_MODEL = "fal-ai/flux/schnell";

export interface FalImageGenConfig {
  apiKey: string;
}

/** fal answers `{ images: [{ url, content_type, width, height }], seed, … }`; only the first two matter. */
const FalImagesResponse = z.object({
  images: z.array(z.object({ url: z.url(), content_type: z.string().optional() })).min(1),
});

/**
 * fal.ai's hosted Flux Schnell, through the synchronous `https://fal.run/…`
 * endpoint with `Authorization: Key <FAL_KEY>`.
 *
 * Schnell rather than Dev or Pro: it is the four-step model, a second or two a
 * picture and well under a penny, which is the whole reason this adapter is
 * here as an alternative to OpenAI. `fal.run` returns the finished result on
 * the same request, so there is no queue to poll — the 60 s timeout is the
 * only bound needed.
 *
 * Unlike OpenAI, fal hands back a **URL** rather than bytes, so a second
 * request downloads it. That request deliberately carries no `Authorization`
 * header: the address comes out of a response body rather than from us, and a
 * key must never be sent to a host we did not choose. The bytes are then
 * sniffed rather than trusted — Schnell's default output is JPEG, but a
 * `content_type` from a CDN is a claim and the first four bytes are the fact.
 */
export class FalImageGenAdapter implements ImageGenAdapter {
  readonly name = "fal" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly endpoint: string;

  constructor(private readonly config: FalImageGenConfig, options: ImageGenHttpOptions = {}) {
    if (!config.apiKey) throw new Error("FalImageGenAdapter needs FAL_KEY");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? IMAGEGEN_TIMEOUT_MS;
    this.endpoint = options.endpoint ?? FAL_FLUX_SCHNELL_ENDPOINT;
  }

  async generate(input: ImageGenInput): Promise<GeneratedImage> {
    const { prompt, size = DEFAULT_IMAGEGEN_SIZE } = ImageGenInputSchema.parse(input);
    const res = await imageGenFetch(this.name, this.fetchImpl, this.timeoutMs, this.endpoint, {
      method: "POST",
      headers: { authorization: `Key ${this.config.apiKey}`, "content-type": "application/json" },
      // `image_size` takes the explicit pair as well as fal's named presets;
      // the pair keeps our three sizes meaning the same thing on both adapters.
      body: JSON.stringify({ prompt, image_size: sizeDimensions(size), num_images: 1 }),
    });
    if (!res.ok) throw await refusalFrom(this.name, res);

    const parsed = FalImagesResponse.safeParse(await res.json().catch(() => null));
    const image = parsed.success ? parsed.data.images[0] : undefined;
    if (!image) throw new ImageGenRefused(this.name, res.status, "the reply carried no image URL at images[0].url");

    const bytes = await this.download(image.url);
    const mime = sniffImageMime(bytes);
    if (!mime) {
      throw new ImageGenRefused(this.name, 0, `${image.content_type ?? "the download"} is neither a PNG nor a JPEG`);
    }
    return { bytes, mime, costPence: FAL_IMAGE_COST_PENCE[size], model: FAL_IMAGE_MODEL };
  }

  private async download(url: string): Promise<Uint8Array> {
    const res = await imageGenFetch(this.name, this.fetchImpl, this.timeoutMs, url, { method: "GET" });
    if (!res.ok) throw await refusalFrom(this.name, res);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) throw new ImageGenRefused(this.name, res.status, "the returned image was empty");
    return bytes;
  }
}
