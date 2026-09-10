import { SiteGenerationError, type GeneratedSite, type SiteBrief, type SiteGeneratorAdapter } from "./types.js";

/**
 * Site generation through OpenAI's chat completions API.
 *
 * **The model is not guessed.** `OPENAI_MODEL` must be set, and there is no
 * default. Shoji names the model he wants by a marketing name; model ids move,
 * get retired and get renamed, and a hardcoded guess would either fail with a
 * confusing 404 or — worse — silently succeed on an older, cheaper model and
 * quietly produce worse sites than he is paying for. An explicit setting fails
 * loudly at the right moment.
 *
 * The response is asked for as JSON and parsed strictly. A model that returns
 * prose where a schema was requested has not done the job, and passing that
 * downstream would put half a sentence on a client's homepage.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAiSiteGeneratorOptions {
  apiKey: string;
  model: string;
  baseUrl?: string | undefined;
  /** Injected in tests. Defaults to the global. */
  fetchImpl?: typeof fetch | undefined;
  /** A slow model on a big brief; generous, but not unbounded. */
  timeoutMs?: number | undefined;
}

const SYSTEM_PROMPT = [
  "You build small marketing websites for UK local businesses.",
  "Return JSON only, matching: {\"pages\":[{\"path\":\"/\",\"title\":\"...\",\"html\":\"...\"}],\"css\":\"...\",\"notes\":\"...\"}.",
  "`html` is the body content for that page: no <html>, <head> or <body> tags, no <script>.",
  "Write plainly, in British English. Never invent a service, a price, a review or an accreditation.",
  "If the brief does not say something, leave it out rather than filling the gap.",
].join(" ");

/** The brief as a prompt. Exported so a person can read exactly what was sent. */
export function buildSitePrompt(brief: SiteBrief): string {
  const lines = [
    `Business name: ${brief.businessName}`,
    brief.industry ? `Industry: ${brief.industry}` : undefined,
    brief.services ? `Services:\n${brief.services}` : undefined,
    brief.serviceArea ? `Areas covered: ${brief.serviceArea}` : undefined,
    brief.goals ? `What they want from the site: ${brief.goals}` : undefined,
    brief.tone ? `Tone: ${brief.tone}` : undefined,
    brief.existingUrl ? `Existing site (better it, do not copy it): ${brief.existingUrl}` : undefined,
    brief.doNotSay ? `Do not claim: ${brief.doNotSay}` : undefined,
  ].filter(Boolean);
  return `${lines.join("\n")}\n\nBuild a home page and a contact page. Add a services page only if there are services above.`;
}

export class OpenAiSiteGenerator implements SiteGeneratorAdapter {
  readonly name = "openai" as const;
  readonly live = true;

  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: OpenAiSiteGeneratorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async generate(brief: SiteBrief): Promise<GeneratedSite> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 120_000);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildSitePrompt(brief) },
          ],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SiteGenerationError("openai", `the request failed: ${detail}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // Their words, not ours: a 429 and a 401 send somebody to different places.
      const body = await response.text().catch(() => "");
      throw new SiteGenerationError("openai", body.slice(0, 400) || response.statusText, response.status);
    }

    const payload = (await response.json().catch(() => null)) as
      | { choices?: { message?: { content?: string } }[] }
      | null;
    const content = payload?.choices?.[0]?.message?.content;
    if (!content) throw new SiteGenerationError("openai", "the reply carried no content");

    return parseGeneratedSite(content, this.options.model);
  }
}

/**
 * Parsed strictly and separately, so a malformed reply is a named failure
 * rather than a page of half-JSON reaching a client's site.
 */
export function parseGeneratedSite(content: string, model: string): GeneratedSite {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new SiteGenerationError("openai", "the reply was not JSON");
  }

  const value = raw as { pages?: unknown; css?: unknown; notes?: unknown };
  if (!Array.isArray(value.pages) || value.pages.length === 0) {
    throw new SiteGenerationError("openai", "the reply contained no pages");
  }

  const pages = value.pages.map((entry, index) => {
    const page = entry as { path?: unknown; title?: unknown; html?: unknown };
    if (typeof page.path !== "string" || typeof page.title !== "string" || typeof page.html !== "string") {
      throw new SiteGenerationError("openai", `page ${index + 1} was missing a path, title or html`);
    }
    return { path: page.path, title: page.title, html: page.html };
  });

  return {
    pages,
    css: typeof value.css === "string" ? value.css : "",
    notes: typeof value.notes === "string" ? value.notes : "",
    model,
  };
}
