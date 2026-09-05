import { describe, expect, it } from "vitest";
import { MockCmsProvider, createCmsProviderFromEnv } from "./index.js";
import { WordPressCmsError, WordPressCmsProvider, type WordPressSiteConnection } from "./wordpress.js";

const SITE_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION: WordPressSiteConnection = {
  baseUrl: "https://grayscabline.co.uk",
  platform: "wordpress",
  username: "shoji",
  appPassword: "abcd EFGH 1234 ijkl",
};

type Call = { url: string; method: string; body: string | undefined; authorization: string | undefined };
type Route = (url: string, method: string) => { status?: number; json?: unknown; text?: string } | undefined;

/** A fetch stub that records every call and answers from `route`. */
function stubFetch(route: Route): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, body: init?.body as string | undefined, authorization: headers.authorization });

    const answer = route(url, method);
    if (!answer) return new Response("not routed", { status: 404 });
    const status = answer.status ?? 200;
    if (answer.text !== undefined) return new Response(answer.text, { status });
    return new Response(JSON.stringify(answer.json ?? null), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function provider(route: Route, connection: WordPressSiteConnection | null = CONNECTION) {
  const { fetchImpl, calls } = stubFetch(route);
  const cms = new WordPressCmsProvider({ resolveSiteCredentials: async () => connection, fetchImpl });
  return { cms, calls };
}

const API = "https://grayscabline.co.uk/wp-json/wp/v2";

describe("WordPressCmsProvider.updateContent", () => {
  it("finds the page by slug, posts converted HTML and returns the new revision id", async () => {
    const { cms, calls } = provider((url, method) => {
      if (url === `${API}/pages?slug=contact&per_page=5`) return { json: [{ id: 42, slug: "contact" }] };
      if (url === `${API}/pages/42` && method === "POST") return { json: { id: 42, modified_gmt: "2026-09-05T10:00:00" } };
      if (url.startsWith(`${API}/pages/42/revisions`)) return { json: [{ id: 907 }] };
      return undefined;
    });

    const result = await cms.updateContent({
      siteRef: "app_1",
      siteId: SITE_ID,
      path: "/contact/",
      contentMd: "# Contact\n\nCall **01375 000000**.",
    });

    expect(result).toEqual({ revisionId: "907", applied: true });

    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toBe(`${API}/pages/42`);
    expect(JSON.parse(post.body!)).toEqual({
      content: "<h1>Contact</h1>\n\n<p>Call <strong>01375 000000</strong>.</p>",
    });
    // Basic auth, built from the per-site credential.
    expect(post.authorization).toBe(`Basic ${Buffer.from("shoji:abcd EFGH 1234 ijkl").toString("base64")}`);
  });

  it("falls back to a post when no page has the slug", async () => {
    const { cms } = provider((url, method) => {
      if (url === `${API}/pages?slug=news-item&per_page=5`) return { json: [] };
      if (url === `${API}/posts?slug=news-item&per_page=5`) return { json: [{ id: 7 }] };
      if (url === `${API}/posts/7` && method === "POST") return { json: { id: 7, modified_gmt: "2026-09-05T10:00:00" } };
      if (url.startsWith(`${API}/posts/7/revisions`)) return { json: [{ id: 12 }] };
      return undefined;
    });

    const result = await cms.updateContent({ siteRef: "app_1", siteId: SITE_ID, path: "/news-item", contentMd: "Hello." });
    expect(result.revisionId).toBe("12");
  });

  it("names the modified object when the revisions endpoint gives nothing back", async () => {
    const { cms } = provider((url, method) => {
      if (url === `${API}/pages?slug=about&per_page=5`) return { json: [{ id: 5 }] };
      if (url === `${API}/pages/5` && method === "POST") return { json: { id: 5, modified_gmt: "2026-09-05T11:30:00" } };
      if (url.startsWith(`${API}/pages/5/revisions`)) return { status: 500, text: "revisions disabled" };
      return undefined;
    });

    const result = await cms.updateContent({ siteRef: "app_1", siteId: SITE_ID, path: "/about", contentMd: "Hi." });
    expect(result).toEqual({ revisionId: "pages-5@2026-09-05T11:30:00", applied: true });
  });

  it("resolves an empty path to the site's front page", async () => {
    const { cms } = provider((url, method) => {
      if (url === `${API}/settings`) return { json: { page_on_front: 2 } };
      if (url === `${API}/pages/2` && method === "POST") return { json: { id: 2, modified_gmt: "x" } };
      if (url.startsWith(`${API}/pages/2/revisions`)) return { json: [{ id: 3 }] };
      return undefined;
    });

    expect((await cms.updateContent({ siteRef: "a", siteId: SITE_ID, path: "/", contentMd: "Home." })).revisionId).toBe("3");
  });

  it("throws page_not_found when neither a page nor a post has the slug", async () => {
    const { cms } = provider((url) => (url.includes("slug=missing") ? { json: [] } : undefined));

    await expect(cms.updateContent({ siteRef: "a", siteId: SITE_ID, path: "/missing", contentMd: "x" })).rejects.toMatchObject({
      name: "WordPressCmsError",
      code: "page_not_found",
    });
  });

  it("throws auth_failed on a 401 and never retries with a different credential", async () => {
    const { cms, calls } = provider(() => ({ status: 401, json: { code: "incorrect_password" } }));

    const error = await cms
      .updateContent({ siteRef: "a", siteId: SITE_ID, path: "/contact", contentMd: "x" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WordPressCmsError);
    expect(error).toMatchObject({ code: "auth_failed", status: 401 });
    expect(calls).toHaveLength(1);
  });

  it("throws request_failed with the status and body on any other error", async () => {
    const { cms } = provider(() => ({ status: 500, text: "database error" }));

    await expect(cms.updateContent({ siteRef: "a", siteId: SITE_ID, path: "/contact", contentMd: "x" })).rejects.toMatchObject({
      code: "request_failed",
      status: 500,
    });
  });

  it("refuses a site with no credential, no site id, or a non-WordPress platform", async () => {
    const none = provider(() => undefined, null).cms;
    await expect(none.updateContent({ siteRef: "a", siteId: SITE_ID, path: "/x", contentMd: "y" })).rejects.toMatchObject({
      code: "no_credentials",
    });

    const ok = provider(() => undefined).cms;
    await expect(ok.updateContent({ siteRef: "a", path: "/x", contentMd: "y" })).rejects.toMatchObject({
      code: "no_credentials",
    });

    const nextjs = provider(() => undefined, { ...CONNECTION, platform: "nextjs" }).cms;
    await expect(nextjs.updateContent({ siteRef: "a", siteId: SITE_ID, path: "/x", contentMd: "y" })).rejects.toMatchObject({
      code: "not_wordpress",
    });
  });

  it("refuses a site whose primary URL is not http(s)", async () => {
    const cms = provider(() => undefined, { ...CONNECTION, baseUrl: "ftp://grayscabline.co.uk" }).cms;
    await expect(cms.updateContent({ siteRef: "a", siteId: SITE_ID, path: "/x", contentMd: "y" })).rejects.toMatchObject({
      code: "invalid_site_url",
    });
  });

  it("keeps a subdirectory install's path in the API base", async () => {
    const { cms, calls } = provider(() => ({ json: [] }), { ...CONNECTION, baseUrl: "https://example.test/blog/" });
    await cms.updateContent({ siteRef: "a", siteId: SITE_ID, path: "/x", contentMd: "y" }).catch(() => undefined);
    expect(calls[0]!.url).toBe("https://example.test/blog/wp-json/wp/v2/pages?slug=x&per_page=5");
  });
});

describe("WordPressCmsProvider.testConnection", () => {
  it("reports the authenticated user on success", async () => {
    const { cms, calls } = provider((url) => (url === `${API}/users/me` ? { json: { id: 1, name: "Shoji" } } : undefined));

    expect(await cms.testConnection({ siteId: SITE_ID })).toEqual({ ok: true, provider: "wordpress", identity: "Shoji" });
    expect(calls[0]!.url).toBe(`${API}/users/me`);
  });

  it("reports a rejected credential instead of throwing", async () => {
    const { cms } = provider(() => ({ status: 401, json: { code: "incorrect_password" } }));

    const result = await cms.testConnection({ siteId: SITE_ID });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/rejected the application password/);
  });

  it("reports a site with no credential", async () => {
    const { cms } = provider(() => undefined, null);
    expect(await cms.testConnection({ siteId: SITE_ID })).toMatchObject({ ok: false });
  });
});

describe("createCmsProviderFromEnv", () => {
  const deps = { resolveSiteCredentials: async () => CONNECTION };

  it("builds the mock while no encryption key is configured", () => {
    expect(createCmsProviderFromEnv({}, deps)).toBeInstanceOf(MockCmsProvider);
    expect(createCmsProviderFromEnv({ SECRETS_ENCRYPTION_KEY: "  " }, deps).name).toBe("mock-cms");
  });

  it("builds the WordPress client once a key is set", () => {
    const cms = createCmsProviderFromEnv({ SECRETS_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") }, deps);
    expect(cms).toBeInstanceOf(WordPressCmsProvider);
    expect(cms.name).toBe("wordpress");
  });
});
