import { describe, expect, it } from "vitest";
import { renderDocumentHtml, documentFooterTemplate, DOCUMENT_MARGIN } from "./document.js";
import { MockPdfRenderer, tinyPdf, titleOf } from "./mock.js";
import { createPdfRenderer, pdfRendererKind, PDF_RENDERER_ENV } from "./factory.js";
import { looksLikePdf } from "./types.js";
import { CHROMIUM_PATH_ENV, chromiumOptionsFromEnv } from "./chromium.js";

describe("document chrome", () => {
  it("escapes everything a client or a model could put in it", () => {
    const html = renderDocumentHtml({
      title: '<script>alert("x")</script>',
      subtitle: "Acme & Sons <b>Ltd</b>",
      meta: [{ label: "Reference", value: "P-2026-014" }],
      paragraphs: ["A quote from the client: \"we're <done>\"", "**not markdown**"],
      closingNote: "VAT at 20% & payable on delivery",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Acme &amp; Sons &lt;b&gt;Ltd&lt;/b&gt;");
    expect(html).toContain("**not markdown**");
    expect(html).toContain("VAT at 20% &amp; payable on delivery");
  });

  it("keeps a newline inside a paragraph as a line break, and drops blank paragraphs", () => {
    const html = renderDocumentHtml({ title: "T", paragraphs: ["one\ntwo", "   ", "three"] });
    expect(html).toContain("one<br />two");
    expect(html).toContain("<p>three</p>");
    expect(html).not.toContain("<p>   </p>");
  });

  it("takes trusted bodyHtml only when there are no paragraphs", () => {
    const table = "<table><tr><td>Setup</td></tr></table>";
    expect(renderDocumentHtml({ title: "T", bodyHtml: table })).toContain(table);
    expect(renderDocumentHtml({ title: "T", bodyHtml: table, paragraphs: ["words"] })).not.toContain(table);
  });

  it("fetches nothing over the network — no img, no link, no @import", () => {
    const html = renderDocumentHtml({ title: "T", paragraphs: ["body"] });
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<link/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/https?:\/\//i);
  });

  it("prints inside the same margins the renderer is told to use", () => {
    const html = renderDocumentHtml({ title: "T" });
    expect(html).toContain(`margin: ${DOCUMENT_MARGIN.top} ${DOCUMENT_MARGIN.right} ${DOCUMENT_MARGIN.bottom} ${DOCUMENT_MARGIN.left};`);
  });

  it("gives the footer the two class names Chromium substitutes, and escapes the reference", () => {
    const footer = documentFooterTemplate('P-2026-014 "Acme"');
    expect(footer).toContain('class="pageNumber"');
    expect(footer).toContain('class="totalPages"');
    expect(footer).toContain("&quot;Acme&quot;");
    expect(documentFooterTemplate()).toContain('class="pageNumber"');
  });
});

/** Reads the `startxref` offset back and checks it points at the real table. */
function xrefIsSound(pdf: Uint8Array): boolean {
  const text = Buffer.from(pdf).toString("latin1");
  const start = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
  return Number.isInteger(start) && text.slice(start, start + 4) === "xref";
}

describe("mock renderer", () => {
  it("returns a PDF a reader would accept: header, sound xref, one page, trailer", () => {
    const pdf = tinyPdf("Proposal P-2026-014");
    const text = Buffer.from(pdf).toString("latin1");
    expect(looksLikePdf(pdf)).toBe(true);
    expect(xrefIsSound(pdf)).toBe(true);
    expect(text).toContain("/Type /Page");
    expect(text).toContain("/Count 1");
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
    // Every object offset in the table has to land on that object's header.
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, index) => expect(text.slice(offset, offset + 7)).toBe(`${index + 1} 0 obj`));
  });

  it("escapes the parentheses and backslashes a title could carry into a PDF string", () => {
    const text = Buffer.from(tinyPdf("Acme (UK) \\ Ltd")).toString("latin1");
    expect(text).toContain("(Acme \\(UK\\) \\\\ Ltd)");
  });

  it("draws the document's title so a test can prove the right document was rendered", async () => {
    const renderer = new MockPdfRenderer();
    const html = renderDocumentHtml({ title: "Proposal for Acme Ltd" });
    const pdf = await renderer.render({ html, footerReference: "P-2026-014" });
    // The reference's own brackets are escaped inside the PDF string literal.
    expect(Buffer.from(pdf).toString("latin1")).toContain("(Proposal for Acme Ltd \\(P-2026-014\\))");
    expect(renderer.rendered).toHaveLength(1);
    expect(renderer.rendered[0]!.footerReference).toBe("P-2026-014");
  });

  it("falls back to a sane title when the html has none", () => {
    expect(titleOf("<html><body>no title</body></html>")).toBe("LaunchFlow document");
  });
});

describe("renderer selection", () => {
  it("is the mock under NODE_ENV=test, so no suite ever launches a browser", () => {
    expect(pdfRendererKind({ NODE_ENV: "test" })).toBe("mock");
    expect(createPdfRenderer({ NODE_ENV: "test" }).kind).toBe("mock");
  });

  it("is chromium everywhere else, because a blank document is worse than a loud failure", () => {
    expect(pdfRendererKind({})).toBe("chromium");
    expect(pdfRendererKind({ NODE_ENV: "production" })).toBe("chromium");
  });

  it("honours an explicit PDF_RENDERER either way", () => {
    expect(pdfRendererKind({ NODE_ENV: "test", [PDF_RENDERER_ENV]: "chromium" })).toBe("chromium");
    expect(pdfRendererKind({ NODE_ENV: "production", [PDF_RENDERER_ENV]: "mock" })).toBe("mock");
  });

  it("treats a blank chromium path as unset, the way an empty Coolify variable arrives", () => {
    expect(chromiumOptionsFromEnv({ [CHROMIUM_PATH_ENV]: "  " }).executablePath).toBeUndefined();
    expect(chromiumOptionsFromEnv({ [CHROMIUM_PATH_ENV]: "/usr/bin/chromium" }).executablePath).toBe("/usr/bin/chromium");
  });
});
