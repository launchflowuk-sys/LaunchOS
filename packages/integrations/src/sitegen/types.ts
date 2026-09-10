/**
 * Handing a brief to a model and getting a website back.
 *
 * Shoji rates another vendor's model for site design and wants the brief to
 * reach it without a person retyping anything. That is one step of a longer
 * chain — lead, brief, generated site, hosting, WordPress, deploy, review,
 * client — and this interface is only the generating step. The rest is
 * `packages/core/src/sitegen`, which owns the order things happen in.
 *
 * Mock-first, per rule 4. The mock is what the tests use and what runs until
 * `OPENAI_API_KEY` is set, so nothing here needs a live account to be built,
 * reviewed or reasoned about.
 */

/** What the model is told. Assembled from the lead's own answers — see `buildSitePrompt`. */
export interface SiteBrief {
  businessName: string;
  industry?: string | undefined;
  services?: string | undefined;
  serviceArea?: string | undefined;
  goals?: string | undefined;
  tone?: string | undefined;
  /** Their existing site, when they have one, so the model can better it rather than repeat it. */
  existingUrl?: string | undefined;
  /** Claims the business cannot support. Carried from the Brief Writer, which is careful about this. */
  doNotSay?: string | undefined;
}

export interface GeneratedPage {
  /** `/`, `/services`, `/contact` — the path this page will live at. */
  path: string;
  title: string;
  /** Complete HTML for the page body. Never a fragment the caller has to finish. */
  html: string;
}

export interface GeneratedSite {
  pages: GeneratedPage[];
  /** One stylesheet for the whole site. */
  css: string;
  /** What the model says it did, for the person reviewing it. */
  notes: string;
  /** Which model produced it, recorded so a bad batch can be traced to its source. */
  model: string;
}

export interface SiteGeneratorAdapter {
  readonly name: "openai" | "mock";
  /** True when a real key is configured. A screen may say so; nothing is forced to. */
  readonly live: boolean;
  generate(brief: SiteBrief): Promise<GeneratedSite>;
}

/**
 * Raised when the provider refuses or breaks. Carries the provider's own words:
 * "the model refused" sends somebody to the wrong place, and a rate-limit
 * message names itself.
 */
export class SiteGenerationError extends Error {
  constructor(
    readonly provider: string,
    message: string,
    readonly status?: number | undefined,
  ) {
    super(message);
    this.name = "SiteGenerationError";
  }
}
