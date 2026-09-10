import { describe, expect, it } from "vitest";
import { MockSiteGenerator } from "./mock.js";
import { OpenAiSiteGenerator, buildSitePrompt, parseGeneratedSite } from "./openai.js";
import { createSiteGeneratorFromEnv } from "./factory.js";
import { SiteGenerationError, type SiteBrief } from "./types.js";

const BRIEF: SiteBrief = {
  businessName: "Taylor Plumbing",
  industry: "Plumbing and heating",
  services: "Boiler servicing\nBathroom installation",
  serviceArea: "Grays and across Thurrock",
  goals: "More emergency callouts",
  doNotSay: "cheapest",
};

function reply(content: unknown, ok = true, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), {
      status: ok ? status : status,
    })) as unknown as typeof fetch;
}

describe("createSiteGeneratorFromEnv", () => {
  /** Mock-first, and deliberately both variables rather than either. */
  it("stays on the mock until a key and an explicit model are both set", () => {
    expect(createSiteGeneratorFromEnv({}).name).toBe("mock");
    expect(createSiteGeneratorFromEnv({ OPENAI_API_KEY: "sk-x" }).name).toBe("mock");
    expect(createSiteGeneratorFromEnv({ OPENAI_MODEL: "some-model" }).name).toBe("mock");
    expect(createSiteGeneratorFromEnv({ OPENAI_API_KEY: "sk-x", OPENAI_MODEL: "some-model" }).name).toBe("openai");
  });

  it("reports whether it is live, so a screen can say so", () => {
    expect(createSiteGeneratorFromEnv({}).live).toBe(false);
    expect(createSiteGeneratorFromEnv({ OPENAI_API_KEY: "sk-x", OPENAI_MODEL: "m" }).live).toBe(true);
  });
});

describe("buildSitePrompt", () => {
  it("carries every answered field, and leaves out what the brief did not say", () => {
    const prompt = buildSitePrompt(BRIEF);
    expect(prompt).toContain("Taylor Plumbing");
    expect(prompt).toContain("Boiler servicing");
    expect(prompt).toContain("Grays and across Thurrock");
    expect(prompt).toContain("Do not claim: cheapest");
    expect(prompt).not.toContain("Tone:");
    expect(prompt).not.toContain("Existing site");
  });
});

describe("MockSiteGenerator", () => {
  /**
   * It uses the real brief on purpose. Lorem ipsum would pass every test while
   * hiding the failure that matters — fields that never reached the prompt.
   */
  it("builds from the brief, so a field that never arrived shows up here", async () => {
    const site = await new MockSiteGenerator().generate(BRIEF);
    expect(site.pages.map((page) => page.path)).toEqual(["/", "/contact"]);
    expect(site.pages[0]!.html).toContain("Taylor Plumbing");
    expect(site.pages[0]!.html).toContain("Boiler servicing");
  });

  it("says plainly that it is a placeholder, so nothing downstream publishes it", async () => {
    const site = await new MockSiteGenerator().generate(BRIEF);
    expect(site.model).toBe("mock");
    expect(site.notes).toMatch(/placeholder/i);
    expect(new MockSiteGenerator().live).toBe(false);
  });

  it("escapes the brief rather than trusting it into markup", async () => {
    const site = await new MockSiteGenerator().generate({ businessName: '<script>alert(1)</script>' });
    expect(site.pages[0]!.html).not.toContain("<script>");
    expect(site.pages[0]!.html).toContain("&lt;script&gt;");
  });
});

describe("parseGeneratedSite", () => {
  it("accepts a well-formed reply and records which model made it", () => {
    const site = parseGeneratedSite(
      JSON.stringify({ pages: [{ path: "/", title: "Home", html: "<h1>Hi</h1>" }], css: "body{}", notes: "done" }),
      "some-model",
    );
    expect(site.model).toBe("some-model");
    expect(site.pages).toHaveLength(1);
  });

  /** Half a sentence of prose must not reach a client's homepage. */
  it("refuses prose where JSON was asked for", () => {
    expect(() => parseGeneratedSite("Certainly! Here is your site.", "m")).toThrow(SiteGenerationError);
  });

  it("refuses a reply with no pages, or a page missing its html", () => {
    expect(() => parseGeneratedSite(JSON.stringify({ pages: [] }), "m")).toThrow(/no pages/);
    expect(() => parseGeneratedSite(JSON.stringify({ pages: [{ path: "/", title: "Home" }] }), "m"))
      .toThrow(/missing a path, title or html/);
  });
});

describe("OpenAiSiteGenerator", () => {
  it("returns the parsed site on a good reply", async () => {
    const generator = new OpenAiSiteGenerator({
      apiKey: "sk-x",
      model: "some-model",
      fetchImpl: reply({ pages: [{ path: "/", title: "Home", html: "<h1>Taylor</h1>" }], css: "", notes: "" }),
    });

    const site = await generator.generate(BRIEF);
    expect(site.pages[0]!.title).toBe("Home");
    expect(site.model).toBe("some-model");
  });

  it("carries the provider's own words on a refusal, because 429 and 401 are different problems", async () => {
    const generator = new OpenAiSiteGenerator({
      apiKey: "sk-x",
      model: "some-model",
      fetchImpl: (async () => new Response("Rate limit reached for requests", { status: 429 })) as unknown as typeof fetch,
    });

    await expect(generator.generate(BRIEF)).rejects.toThrow(/Rate limit reached/);
    await expect(generator.generate(BRIEF)).rejects.toMatchObject({ status: 429 });
  });

  it("names a transport failure rather than leaving an empty error", async () => {
    const generator = new OpenAiSiteGenerator({
      apiKey: "sk-x",
      model: "some-model",
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch,
    });

    await expect(generator.generate(BRIEF)).rejects.toThrow(/socket hang up/);
  });
});
