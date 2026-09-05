import { describe, expect, it } from "vitest";
import { MockCmsProvider } from "./index.js";
import { WordPressCmsError, WordPressCmsProvider, type WordPressSiteConnection } from "./wordpress.js";

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION: WordPressSiteConnection = {
  baseUrl: "https://grayscabline.co.uk",
  platform: "wordpress",
  username: "shoji",
  appPassword: "abcd EFGH 1234 ijkl",
};
const API = "https://grayscabline.co.uk/wp-json/wp/v2";
const AUTH = `Basic ${Buffer.from("shoji:abcd EFGH 1234 ijkl").toString("base64")}`;

type Call = { url: string; method: string; body: string | Uint8Array | undefined; headers: Record<string, string> };
type Answer = { status?: number; json?: unknown; text?: string; bytes?: Uint8Array; headers?: Record<string, string> };
type Route = (url: string, method: string, call: Call) => Answer | undefined;

function stubFetch(route: Route): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const call: Call = { url, method, body: init?.body as string | Uint8Array | undefined, headers };
    calls.push(call);
    const answer = route(url, method, call);
    if (!answer) return new Response("not routed", { status: 404 });
    const status = answer.status ?? 200;
    if (answer.bytes !== undefined) return new Response(answer.bytes, { status, headers: answer.headers ?? {} });
    if (answer.text !== undefined) return new Response(answer.text, { status, headers: answer.headers ?? {} });
    return new Response(JSON.stringify(answer.json ?? null), {
      status,
      headers: { "content-type": "application/json", ...(answer.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function provider(route: Route, connection: WordPressSiteConnection | null = CONNECTION) {
  const { fetchImpl, calls } = stubFetch(route);
  const cms = new WordPressCmsProvider({ resolveSiteCredentials: async () => connection, fetchImpl });
  return { cms, calls };
}

const POST_INPUT = {
  siteId: SITE_ID,
  title: "Airport transfers from Grays: what to expect",
  contentMarkdown: "## Fixed fares\n\nWe quote **before** you travel.\n\n- Heathrow\n- Gatwick",
  status: "publish" as const,
};

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe("WordPressCmsProvider.createPost", () => {
  it("posts converted HTML to /posts and returns the id and link", async () => {
    const { cms, calls } = provider((url, method) => {
      if (url === `${API}/posts` && method === "POST") {
        return { status: 201, json: { id: 321, link: "https://grayscabline.co.uk/airport-transfers-from-grays/", status: "publish" } };
      }
      return undefined;
    });

    const result = await cms.createPost({ ...POST_INPUT, excerpt: "Fixed fares to every London airport." });

    expect(result).toEqual({
      externalId: "321",
      url: "https://grayscabline.co.uk/airport-transfers-from-grays/",
      status: "publish",
    });
    expect(calls).toHaveLength(1);
    const post = calls[0]!;
    expect(post.headers.authorization).toBe(AUTH);
    expect(post.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(post.body as string)).toEqual({
      title: "Airport transfers from Grays: what to expect",
      content: "<h2>Fixed fares</h2>\n\n<p>We quote <strong>before</strong> you travel.</p>\n\n<ul>\n  <li>Heathrow</li>\n  <li>Gatwick</li>\n</ul>",
      status: "publish",
      excerpt: "Fixed fares to every London airport.",
    });
  });

  it("creates a draft when asked, and reports the status WordPress actually applied", async () => {
    const { cms, calls } = provider((url, method) =>
      url === `${API}/posts` && method === "POST"
        ? { status: 201, json: { id: 5, link: "https://grayscabline.co.uk/?p=5", status: "draft" } }
        : undefined,
    );
    const result = await cms.createPost({ ...POST_INPUT, status: "draft" });
    expect(result).toEqual({ externalId: "5", url: "https://grayscabline.co.uk/?p=5", status: "draft" });
    expect(JSON.parse(calls[0]!.body as string).status).toBe("draft");
  });

  it("resolves category names to ids — reusing an existing one, creating a missing one", async () => {
    const { cms, calls } = provider((url, method) => {
      if (url === `${API}/categories?search=News&per_page=20`) return { json: [{ id: 3, name: "News" }, { id: 9, name: "Newsletter" }] };
      if (url === `${API}/categories?search=Taxis%20%26%20Transfers&per_page=20`) return { json: [{ id: 7, name: "Taxis &amp; Transfers" }] };
      if (url === `${API}/categories?search=Airports&per_page=20`) return { json: [] };
      if (url === `${API}/categories` && method === "POST") return { status: 201, json: { id: 12, name: "Airports" } };
      if (url === `${API}/posts` && method === "POST") return { status: 201, json: { id: 1, link: "https://x/1", status: "publish" } };
      return undefined;
    });

    const result = await cms.createPost({ ...POST_INPUT, categories: ["News", "Taxis & Transfers", "Airports"] });

    expect(result.note).toBeUndefined();
    expect(JSON.parse(calls.find((c) => c.url === `${API}/categories` && c.method === "POST")!.body as string)).toEqual({ name: "Airports" });
    expect(JSON.parse(calls.at(-1)!.body as string).categories).toEqual([3, 7, 12]);
  });

  it("skips a category the credential cannot create, with a note, and still publishes", async () => {
    const { cms } = provider((url, method) => {
      if (url.startsWith(`${API}/categories?`)) return { json: [] };
      if (url === `${API}/categories` && method === "POST") return { status: 403, json: { code: "rest_cannot_create" } };
      if (url === `${API}/posts` && method === "POST") return { status: 201, json: { id: 1, link: "https://x/1", status: "publish" } };
      return undefined;
    });
    const result = await cms.createPost({ ...POST_INPUT, categories: ["Offers"] });
    expect(result.externalId).toBe("1");
    expect(result.note).toMatch(/Category "Offers" was skipped/);
  });

  it("sideloads the featured image into the media library and attaches it", async () => {
    const { cms, calls } = provider((url, method, call) => {
      if (url === "https://cdn.example.com/heroes/heathrow.jpg") return { bytes: JPEG, headers: { "content-type": "image/jpeg", "content-length": "6" } };
      if (url === `${API}/media` && method === "POST") {
        expect(call.headers["content-type"]).toBe("image/jpeg");
        expect(call.headers["content-disposition"]).toBe('attachment; filename="heathrow.jpg"');
        expect(call.headers.authorization).toBe(AUTH);
        expect(call.body).toBeInstanceOf(Uint8Array);
        expect(Array.from(call.body as Uint8Array)).toEqual(Array.from(JPEG));
        return { status: 201, json: { id: 88, source_url: "https://grayscabline.co.uk/wp-content/uploads/heathrow.jpg" } };
      }
      if (url === `${API}/posts` && method === "POST") return { status: 201, json: { id: 2, link: "https://x/2", status: "publish" } };
      return undefined;
    });

    const result = await cms.createPost({ ...POST_INPUT, featuredImageUrl: "https://cdn.example.com/heroes/heathrow.jpg" });

    expect(result.note).toBeUndefined();
    const image = calls.find((c) => c.url.startsWith("https://cdn.example.com"))!;
    // The image host gets no WordPress credential.
    expect(image.headers.authorization).toBeUndefined();
    expect(JSON.parse(calls.at(-1)!.body as string).featured_media).toBe(88);
  });

  it("publishes without the image, noting why, when the upload is refused", async () => {
    const { cms, calls } = provider((url, method) => {
      if (url === "https://cdn.example.com/a.png") return { bytes: JPEG, headers: { "content-type": "image/png" } };
      if (url === `${API}/media` && method === "POST") return { status: 403, json: { code: "rest_cannot_create" } };
      if (url === `${API}/posts` && method === "POST") return { status: 201, json: { id: 3, link: "https://x/3", status: "publish" } };
      return undefined;
    });
    const result = await cms.createPost({ ...POST_INPUT, featuredImageUrl: "https://cdn.example.com/a.png" });
    expect(result.externalId).toBe("3");
    expect(result.note).toMatch(/Featured image was skipped: WordPress rejected the application password \(403\)/);
    expect(JSON.parse(calls.at(-1)!.body as string)).not.toHaveProperty("featured_media");
  });

  it("does not upload something that is not an image, or an image that is too big, or a non-http URL", async () => {
    const routes: Route = (url, method) => {
      if (url === "https://cdn.example.com/page") return { text: "<html>", headers: { "content-type": "text/html" } };
      if (url === "https://cdn.example.com/huge.jpg") return { bytes: JPEG, headers: { "content-type": "image/jpeg", "content-length": String(11 * 1024 * 1024) } };
      if (url === `${API}/posts` && method === "POST") return { status: 201, json: { id: 4, link: "https://x/4", status: "publish" } };
      return undefined;
    };
    for (const [featuredImageUrl, why] of [
      ["https://cdn.example.com/page", /text\/html, not an image/],
      ["https://cdn.example.com/huge.jpg", /the limit is/],
      ["ftp://cdn.example.com/a.jpg", /not an http\(s\) URL/],
      ["not a url", /is not a URL/],
    ] as const) {
      const { cms, calls } = provider(routes);
      const result = await cms.createPost({ ...POST_INPUT, featuredImageUrl });
      expect(result.note, featuredImageUrl).toMatch(why);
      expect(calls.some((c) => c.url === `${API}/media`), featuredImageUrl).toBe(false);
      expect(result.externalId).toBe("4");
    }
  });

  it("throws auth_failed when WordPress rejects the credential on the post itself", async () => {
    const { cms, calls } = provider(() => ({ status: 401, json: { code: "incorrect_password" } }));
    const error = await cms.createPost(POST_INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WordPressCmsError);
    expect(error).toMatchObject({ code: "auth_failed", status: 401 });
    expect(calls).toHaveLength(1);
  });

  it("throws request_failed on any other failure, with the status", async () => {
    const { cms } = provider(() => ({ status: 500, text: "database error" }));
    await expect(cms.createPost(POST_INPUT)).rejects.toMatchObject({ code: "request_failed", status: 500 });
  });

  it("refuses a site with no credential or the wrong platform before sending anything", async () => {
    await expect(provider(() => undefined, null).cms.createPost(POST_INPUT)).rejects.toMatchObject({ code: "no_credentials" });
    await expect(provider(() => undefined, { ...CONNECTION, platform: "nextjs" }).cms.createPost(POST_INPUT)).rejects.toMatchObject({
      code: "not_wordpress",
    });
  });

  it("names a post WordPress created without an id", async () => {
    const { cms } = provider(() => ({ status: 201, json: { link: "https://x" } }));
    await expect(cms.createPost(POST_INPUT)).rejects.toThrow(/returned no id/);
  });
});

describe("MockCmsProvider.createPost", () => {
  it("records the post and answers with deterministic ids", async () => {
    const cms = new MockCmsProvider();
    const first = await cms.createPost(POST_INPUT);
    const second = await cms.createPost({ ...POST_INPUT, status: "draft" });
    expect(first).toEqual({ externalId: "mock-post-1", url: "https://mock-cms.local/?p=1", status: "publish" });
    expect(second).toEqual({ externalId: "mock-post-2", url: "https://mock-cms.local/?p=2", status: "draft" });
    expect(cms.posts).toHaveLength(2);
    expect(cms.posts[1]!.status).toBe("draft");
  });
});
