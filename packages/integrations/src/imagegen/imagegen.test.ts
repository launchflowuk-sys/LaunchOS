import { describe, expect, it, vi } from "vitest";
import { describeAdapters, productionAdapterIssues, productionMockWarnings, resolveAdapters } from "../adapter-guard.js";
import { createIntegrations } from "../index.js";
import { FAL_IMAGE_COST_PENCE, OPENAI_IMAGE_COST_PENCE } from "./cost.js";
import { FAL_FLUX_SCHNELL_ENDPOINT, FalImageGenAdapter } from "./fal.js";
import { IMAGEGEN_ADAPTER_NAMES, createImageGenAdapterFromEnv } from "./index.js";
import { MOCK_IMAGE_GROUND, MockImageGenAdapter } from "./mock.js";
import { OPENAI_IMAGES_ENDPOINT, OPENAI_IMAGE_MODEL, OpenAiImageGenAdapter } from "./openai.js";
import { encodeBandedPng, parseHexColour } from "./png.js";
import { ImageGenRefused, isImageGenRefused } from "./types.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A one-pixel JPEG's first three bytes are all `sniffImageMime` looks at. */
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** `width` and `height` out of a PNG's IHDR, so a test can assert what was actually drawn. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("MockImageGenAdapter", () => {
  it("draws a deterministic branded PNG at the requested size, records the prompt and costs nothing", async () => {
    const mock = new MockImageGenAdapter();
    const square = await mock.generate({ prompt: "  a taxi outside Grays station  " });
    expect(square.mime).toBe("image/png");
    expect(square.costPence).toBe(0);
    expect(square.model).toBe("mock");
    expect([...square.bytes.slice(0, 8)]).toEqual(PNG_SIGNATURE);
    expect(pngSize(square.bytes)).toEqual({ width: 1024, height: 1024 });
    // The prompt is trimmed by the schema before it reaches an adapter.
    expect(mock.calls).toEqual([{ prompt: "a taxi outside Grays station", size: "1024x1024" }]);

    const landscape = await mock.generate({ prompt: "x", size: "1536x1024" });
    expect(pngSize(landscape.bytes)).toEqual({ width: 1536, height: 1024 });

    const again = await mock.generate({ prompt: "different words entirely" });
    expect([...again.bytes]).toEqual([...square.bytes]);
    // Cached but copied out, so one caller cannot scribble on another's image.
    expect(again.bytes).not.toBe(square.bytes);
  });

  it("validates its input at the boundary and can fail the next call on demand", async () => {
    const mock = new MockImageGenAdapter();
    await expect(mock.generate({ prompt: "   " })).rejects.toThrow();
    await expect(mock.generate({ prompt: "x".repeat(4001) })).rejects.toThrow();
    await expect(mock.generate({ prompt: "x", size: "800x600" as never })).rejects.toThrow();
    expect(mock.calls).toHaveLength(0);

    mock.failNext = new Error("boom");
    await expect(mock.generate({ prompt: "x" })).rejects.toThrow("boom");
    await expect(mock.generate({ prompt: "x" })).resolves.toMatchObject({ model: "mock" });
  });

  it("encodes a band whose two colours both appear, so a placeholder is never a blank square", () => {
    const png = encodeBandedPng({
      width: 8,
      height: 8,
      ground: parseHexColour(MOCK_IMAGE_GROUND),
      band: parseHexColour("#ffffff"),
      bandRows: [0.5, 0.75],
    });
    expect(pngSize(png)).toEqual({ width: 8, height: 8 });
    expect(parseHexColour(MOCK_IMAGE_GROUND)).toEqual({ r: 0x09, g: 0x69, b: 0xca });
    expect(() => parseHexColour("blue")).toThrow(/hex colour/);
  });
});

describe("OpenAiImageGenAdapter", () => {
  it("posts gpt-image-1 without response_format, decodes data[0].b64_json and prices the size", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const png = Buffer.from([...PNG_SIGNATURE, 1, 2, 3]);
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json(200, { created: 1, data: [{ b64_json: png.toString("base64") }], usage: { total_tokens: 1 } });
    });
    const openai = new OpenAiImageGenAdapter({ apiKey: "sk-test" }, { fetch: fetchImpl as unknown as typeof fetch });

    const image = await openai.generate({ prompt: "a bright shopfront in Grays", size: "1536x1024" });
    expect(image).toEqual({
      bytes: new Uint8Array(png),
      mime: "image/png",
      costPence: OPENAI_IMAGE_COST_PENCE["1536x1024"],
      model: OPENAI_IMAGE_MODEL,
    });
    expect(calls[0]!.url).toBe(OPENAI_IMAGES_ENDPOINT);
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({ model: "gpt-image-1", prompt: "a bright shopfront in Grays", size: "1536x1024", n: 1 });
    expect(body).not.toHaveProperty("response_format");
    expect(OPENAI_IMAGE_COST_PENCE["1024x1024"]).toBe(4);
  });

  it("classifies a refusal rather than throwing raw, and refuses a 200 with no image in it", async () => {
    const reply = (status: number, body: unknown) => async () => json(status, body);
    const adapter = (fetchImpl: () => Promise<Response>) =>
      new OpenAiImageGenAdapter({ apiKey: "sk" }, { fetch: fetchImpl as unknown as typeof fetch });

    await expect(adapter(reply(401, { error: { message: "Incorrect API key" } })).generate({ prompt: "x" }))
      .rejects.toMatchObject({ name: "ImageGenRefused", code: "auth", status: 401, provider: "openai" });
    await expect(adapter(reply(429, { error: { message: "Rate limit reached" } })).generate({ prompt: "x" }))
      .rejects.toMatchObject({ code: "rate_limit", status: 429 });
    await expect(adapter(reply(400, { error: { message: "Your request was rejected by our safety system" } })).generate({ prompt: "x" }))
      .rejects.toMatchObject({ code: "content_policy" });
    await expect(adapter(reply(500, { error: { message: "server error" } })).generate({ prompt: "x" }))
      .rejects.toMatchObject({ code: "request_failed", status: 500 });
    await expect(adapter(reply(200, { data: [{}] })).generate({ prompt: "x" }))
      .rejects.toThrow(/no image at data\[0\]\.b64_json/);
    await expect(adapter(reply(200, { data: [{ b64_json: "" }] })).generate({ prompt: "x" }))
      .rejects.toThrow(/no image at data\[0\]\.b64_json/);

    // A non-JSON error body is still worth quoting back.
    const html = async () => new Response("<html>502 Bad Gateway</html>", { status: 502 });
    await expect(adapter(html).generate({ prompt: "x" })).rejects.toThrow(/502 Bad Gateway/);
    expect(() => new OpenAiImageGenAdapter({ apiKey: "" })).toThrow(/OPENAI_API_KEY/);
  });

  it("gives up after the timeout instead of holding a queue slot for ever", async () => {
    const hanging = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    const slow = new OpenAiImageGenAdapter({ apiKey: "sk" }, { fetch: hanging as unknown as typeof fetch, timeoutMs: 10 });
    await expect(slow.generate({ prompt: "x" })).rejects.toMatchObject({ code: "timeout", status: 0 });
  });
});

describe("FalImageGenAdapter", () => {
  it("posts an explicit width and height, downloads the returned URL without the key, and sniffs the mime", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (String(url) === FAL_FLUX_SCHNELL_ENDPOINT) {
        return json(200, { images: [{ url: "https://fal.media/files/one.jpeg", content_type: "image/jpeg" }], seed: 7 });
      }
      return new Response(JPEG_BYTES, { status: 200 });
    });
    const fal = new FalImageGenAdapter({ apiKey: "fal-key" }, { fetch: fetchImpl as unknown as typeof fetch });

    const image = await fal.generate({ prompt: "a hairdresser at work", size: "1024x1536" });
    expect(image).toEqual({
      bytes: JPEG_BYTES,
      mime: "image/jpeg",
      costPence: FAL_IMAGE_COST_PENCE["1024x1536"],
      model: "fal-ai/flux/schnell",
    });
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Key fal-key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      prompt: "a hairdresser at work", image_size: { width: 1024, height: 1536 }, num_images: 1,
    });
    // The download address comes out of a response body, so the key never goes with it.
    expect(calls[1]!.url).toBe("https://fal.media/files/one.jpeg");
    expect(calls[1]!.init.headers).toBeUndefined();
  });

  it("refuses a reply with no URL, a failed download and bytes that are not an image", async () => {
    const build = (impl: (url: string) => Promise<Response>) =>
      new FalImageGenAdapter({ apiKey: "k" }, { fetch: ((url: string | URL | Request) => impl(String(url))) as unknown as typeof fetch });

    await expect(build(async () => json(200, { images: [] })).generate({ prompt: "x" }))
      .rejects.toThrow(/no image URL at images\[0\]\.url/);
    await expect(build(async () => json(422, { detail: [{ msg: "the safety checker rejected this prompt" }] })).generate({ prompt: "x" }))
      .rejects.toMatchObject({ code: "content_policy", status: 422 });
    await expect(
      build(async (url) => (url === FAL_FLUX_SCHNELL_ENDPOINT
        ? json(200, { images: [{ url: "https://fal.media/gone.jpeg" }] })
        : json(404, { detail: "not found" }))).generate({ prompt: "x" }),
    ).rejects.toMatchObject({ code: "request_failed", status: 404 });
    await expect(
      build(async (url) => (url === FAL_FLUX_SCHNELL_ENDPOINT
        ? json(200, { images: [{ url: "https://fal.media/one.svg", content_type: "image/svg+xml" }] })
        : new Response(new Uint8Array([0x3c, 0x73, 0x76, 0x67]), { status: 200 }))).generate({ prompt: "x" }),
    ).rejects.toThrow(/neither a PNG nor a JPEG/);
    expect(() => new FalImageGenAdapter({ apiKey: "" })).toThrow(/FAL_KEY/);
    expect(isImageGenRefused(new ImageGenRefused("fal", 0, "x"))).toBe(true);
    expect(isImageGenRefused(new Error("x"))).toBe(false);
  });
});

describe("selection", () => {
  it("builds a real generator only when IMAGEGEN_ADAPTER names one and its key is set", () => {
    expect(createImageGenAdapterFromEnv({}).name).toBe("mock");
    expect(createImageGenAdapterFromEnv({ IMAGEGEN_ADAPTER: "mock", OPENAI_API_KEY: "sk" }).name).toBe("mock");
    // A key on its own must never start spending — the whole point of selecting by name.
    expect(createImageGenAdapterFromEnv({ OPENAI_API_KEY: "sk", FAL_KEY: "k" }).name).toBe("mock");
    expect(createImageGenAdapterFromEnv({ IMAGEGEN_ADAPTER: "openai" }).name).toBe("mock");
    expect(createImageGenAdapterFromEnv({ IMAGEGEN_ADAPTER: "openai", OPENAI_API_KEY: " " }).name).toBe("mock");
    expect(createImageGenAdapterFromEnv({ IMAGEGEN_ADAPTER: "openai", OPENAI_API_KEY: "sk" }).name).toBe("openai");
    expect(createImageGenAdapterFromEnv({ IMAGEGEN_ADAPTER: " fal ", FAL_KEY: "k" }).name).toBe("fal");
    expect(createImageGenAdapterFromEnv({ IMAGEGEN_ADAPTER: "openapi", OPENAI_API_KEY: "sk" }).name).toBe("mock");
    expect(createIntegrations({}).imagegen.name).toBe("mock");
    expect(IMAGEGEN_ADAPTER_NAMES).toEqual(["mock", "openai", "fal"]);
  });

  it("is a log-not-refuse guard row: unset warns, a half-set or misspelt one is refused", () => {
    expect(describeAdapters({})["imagegen"]).toBe("mock");
    expect(describeAdapters({ IMAGEGEN_ADAPTER: "fal", FAL_KEY: "k" })["imagegen"]).toBe("fal");
    expect(resolveAdapters({}).find((a) => a.name === "imagegen")).toMatchObject({
      variable: "IMAGEGEN_ADAPTER", mockWhenUnset: "log", requested: "mock", resolved: "mock",
    });

    const live = { NODE_ENV: "production", EMAIL_ADAPTER: "smtp", SMTP_HOST: "smtp.test", UPTIME_PROBE: "http", PAYMENTS_ADAPTER: "stripe", STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh" };
    const forImagegen = (env: Record<string, string>) => productionAdapterIssues(env).filter((i) => i.variable === "IMAGEGEN_ADAPTER");

    expect(forImagegen(live)).toEqual([]);
    expect(productionMockWarnings(live).find((w) => w.variable === "IMAGEGEN_ADAPTER")?.message)
      .toMatch(/imagegen adapter is the MOCK .* branded template graphics/);
    expect(forImagegen({ ...live, IMAGEGEN_ADAPTER: "openai" })[0]?.message).toMatch(/Missing: OPENAI_API_KEY/);
    expect(forImagegen({ ...live, IMAGEGEN_ADAPTER: "fal" })[0]?.message).toMatch(/Missing: FAL_KEY/);
    expect(forImagegen({ ...live, IMAGEGEN_ADAPTER: "openapi", OPENAI_API_KEY: "sk" })[0]?.message)
      .toMatch(/must be one of mock, openai, fal/);
    expect(forImagegen({ ...live, IMAGEGEN_ADAPTER: "openai", OPENAI_API_KEY: "sk" })).toEqual([]);
    expect(forImagegen({ ...live, IMAGEGEN_ADAPTER: "fal", FAL_KEY: "k" })).toEqual([]);
  });
});
