import type { GeneratedSite, SiteBrief, SiteGeneratorAdapter } from "./types.js";

/**
 * Builds a small, obviously-placeholder site from the brief.
 *
 * It uses the real business name and services on purpose: a mock that returned
 * lorem ipsum would pass every test while hiding the one failure that matters —
 * a brief whose fields never reached the prompt. Using them means an empty
 * service list shows up as an empty page here, in a test, rather than on a
 * client's domain.
 *
 * It is also unmistakably not a finished site. `live` is false and the notes
 * say so, so nothing downstream can mistake this for something to publish.
 */
export class MockSiteGenerator implements SiteGeneratorAdapter {
  readonly name = "mock" as const;
  readonly live = false;

  async generate(brief: SiteBrief): Promise<GeneratedSite> {
    const services = (brief.services ?? "")
      .split(/\r?\n|,/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const list = services.length > 0
      ? `<ul>${services.map((service) => `<li>${escape(service)}</li>`).join("")}</ul>`
      : `<p>No services were given in the brief.</p>`;

    const area = brief.serviceArea ? `<p>Covering ${escape(brief.serviceArea)}.</p>` : "";

    return {
      model: "mock",
      notes: "Placeholder site from the mock generator. Set OPENAI_API_KEY and OPENAI_MODEL to generate for real.",
      css: "body{font-family:system-ui,sans-serif;margin:0;padding:2rem;line-height:1.6}h1{margin:0 0 1rem}",
      pages: [
        {
          path: "/",
          title: brief.businessName,
          html: `<h1>${escape(brief.businessName)}</h1>${
            brief.industry ? `<p>${escape(brief.industry)}</p>` : ""
          }${area}${list}`,
        },
        {
          path: "/contact",
          title: `Contact ${brief.businessName}`,
          html: `<h1>Contact</h1><p>Get in touch with ${escape(brief.businessName)}.</p>`,
        },
      ],
    };
  }
}

/** The site is stored and later served; nothing from a brief is trusted into markup. */
function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
