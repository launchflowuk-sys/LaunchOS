import { z } from "zod";
import { OPENAI_IMAGE_COST_PENCE } from "./cost.js";
import { IMAGEGEN_TIMEOUT_MS, imageGenFetch, refusalFrom, type ImageGenHttpOptions } from "./request.js";
import {
  DEFAULT_IMAGEGEN_SIZE,
  ImageGenInputSchema,
  ImageGenRefused,
  type GeneratedImage,
  type ImageGenAdapter,
  type ImageGenInput,
} from "./types.js";

export const OPENAI_IMAGES_ENDPOINT = "https://api.openai.com/v1/images/generations";
export const OPENAI_IMAGE_MODEL = "gpt-image-1";

export interface OpenAiImageGenConfig {
  apiKey: string;
}

/**
 * The only fields we read. Declared rather than cast so a shape change is a
 * refusal with a sentence in it, not an undefined three lines later — and
 * lenient about everything else (`usage`, `created`, the revised prompt), which
 * we neither need nor want to break on.
 */
const OpenAiImagesResponse = z.object({
  data: z.array(z.object({ b64_json: z.string().optional() })).min(1),
});

/**
 * OpenAI `gpt-image-1`, through `POST /v1/images/generations` with a bearer
 * `OPENAI_API_KEY`.
 *
 * Two things about that endpoint are worth writing down, because both have
 * caught people out:
 *
 * - **`response_format` is not sent.** It belongs to the older `dall-e-*`
 *   models; `gpt-image-1` rejects it outright and always answers with base64
 *   at `data[0].b64_json`. There is no URL to fetch and nothing to choose.
 * - **Quality is left unset**, which means `medium`, which is what `cost.ts`
 *   prices. Asking for `high` costs roughly four times as much for detail that
 *   is invisible on a phone.
 *
 * The output is PNG, which is the model's default `output_format` and the one
 * `createContentAsset` stores without conversion.
 */
export class OpenAiImageGenAdapter implements ImageGenAdapter {
  readonly name = "openai" as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly endpoint: string;

  constructor(private readonly config: OpenAiImageGenConfig, options: ImageGenHttpOptions = {}) {
    if (!config.apiKey) throw new Error("OpenAiImageGenAdapter needs OPENAI_API_KEY");
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? IMAGEGEN_TIMEOUT_MS;
    this.endpoint = options.endpoint ?? OPENAI_IMAGES_ENDPOINT;
  }

  async generate(input: ImageGenInput): Promise<GeneratedImage> {
    const { prompt, size = DEFAULT_IMAGEGEN_SIZE } = ImageGenInputSchema.parse(input);
    const res = await imageGenFetch(this.name, this.fetchImpl, this.timeoutMs, this.endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: OPENAI_IMAGE_MODEL, prompt, size, n: 1 }),
    });
    if (!res.ok) throw await refusalFrom(this.name, res);

    const parsed = OpenAiImagesResponse.safeParse(await res.json().catch(() => null));
    const encoded = parsed.success ? parsed.data.data[0]?.b64_json : undefined;
    if (!encoded) {
      throw new ImageGenRefused(this.name, res.status, "the reply carried no image at data[0].b64_json");
    }
    const bytes = Buffer.from(encoded, "base64");
    // A 200 with an empty or unparseable payload spends the money and returns
    // nothing; better a refusal the caller can fall back from than a zero-byte
    // asset that reaches a client's Facebook page.
    if (bytes.length === 0) throw new ImageGenRefused(this.name, res.status, "the returned image was empty");

    return {
      bytes: new Uint8Array(bytes),
      mime: "image/png",
      costPence: OPENAI_IMAGE_COST_PENCE[size],
      model: OPENAI_IMAGE_MODEL,
    };
  }
}
