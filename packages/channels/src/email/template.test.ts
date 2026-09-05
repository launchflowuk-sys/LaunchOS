import { describe, expect, it } from "vitest";
import {
  BRAND,
  escapeHtml,
  paragraphsFromBody,
  renderBrandedEmail,
  type BrandedEmailInput,
} from "./template.js";

const BASE: BrandedEmailInput = {
  preheader: "We have replied to your case.",
  heading: "Hosting is slow",
  paragraphs: ["Hello Jo,", "We have moved you to a bigger box."],
  logoUrl: "https://os.launchflow.test/brand/launchflow-logo@600.png",
  appUrl: "https://os.launchflow.test",
};

describe("renderBrandedEmail", () => {
  it("puts the heading in the html and at the top of the text alternative", () => {
    const { html, text } = renderBrandedEmail(BASE);

    expect(html).toContain("Hosting is slow");
    expect(text.startsWith("Hosting is slow")).toBe(true);
    expect(text).toContain("We have moved you to a bigger box.");
  });

  it("renders every paragraph, and a newline inside one as a line break", () => {
    const { html } = renderBrandedEmail({ ...BASE, paragraphs: ["One\nTwo", "Three"] });

    expect(html).toContain("One<br />Two");
    expect(html).toContain("Three");
  });

  it("renders the CTA as a link to the given url", () => {
    const { html, text } = renderBrandedEmail({
      ...BASE,
      cta: { label: "View your case", url: "https://os.launchflow.test/portal/support/abc" },
    });

    expect(html).toContain('href="https://os.launchflow.test/portal/support/abc"');
    expect(html).toContain("View your case");
    expect(html).toContain(BRAND.blue);
    expect(text).toContain("View your case: https://os.launchflow.test/portal/support/abc");
  });

  it("carries the brand: the cyan accent bar, the ground, and the footer", () => {
    const { html, text } = renderBrandedEmail({ ...BASE, supportEmail: "hello@launchflow.test" });

    expect(html).toContain(BRAND.cyan);
    expect(html).toContain(BRAND.ground);
    expect(html).toContain('alt="LaunchFlow"');
    expect(html).toContain(BASE.logoUrl);
    expect(html).toContain("Powered by LaunchFlow");
    expect(html).toContain("hello@launchflow.test");
    expect(html).toContain("os.launchflow.test");
    expect(text).toContain("Powered by LaunchFlow");
    expect(text).toContain("hello@launchflow.test");
  });

  it("is fluid, so it fits a 375px phone as well as Outlook's 600px", () => {
    const { html } = renderBrandedEmail(BASE);

    expect(html).toContain("max-width:600px");
    expect(html).toContain('width="100%"');
    // The one image must never force a horizontal scroll on a narrow client.
    expect(html).toContain("max-width:100%");
  });
});

describe("renderBrandedEmail escaping", () => {
  it("escapes a heading, so a case subject cannot open a tag", () => {
    const { html } = renderBrandedEmail({ ...BASE, heading: '<script>alert("x")</script>' });

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes body text, so a client's reply cannot inject markup", () => {
    const { html } = renderBrandedEmail({
      ...BASE,
      paragraphs: ['<img src=x onerror="alert(1)"> & "quoted"'],
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;");
  });

  it("escapes the preheader and the CTA label", () => {
    const { html } = renderBrandedEmail({
      ...BASE,
      preheader: "</div><script>x</script>",
      cta: { label: "<b>Go</b>", url: "https://os.launchflow.test/x" },
    });

    expect(html).not.toContain("<script>x</script>");
    expect(html).not.toContain("<b>Go</b>");
    expect(html).toContain("&lt;b&gt;Go&lt;/b&gt;");
  });

  it("leaves markdown as literal text rather than turning it into markup", () => {
    const { html, text } = renderBrandedEmail({
      ...BASE,
      paragraphs: ["**Spend** was up 12% and <b>CTR</b> fell."],
    });

    expect(html).toContain("**Spend** was up 12% and &lt;b&gt;CTR&lt;/b&gt; fell.");
    expect(text).toContain("**Spend** was up 12% and <b>CTR</b> fell.");
  });

  it("drops a CTA that is not an http(s) url", () => {
    const { html, text } = renderBrandedEmail({
      ...BASE,
      cta: { label: "Click", url: `java${"script"}:alert(1)` },
    });

    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("Click");
    expect(text).not.toContain("Click");
  });

  it("falls back to a text wordmark when the logo url is unusable", () => {
    const { html } = renderBrandedEmail({ ...BASE, logoUrl: "not-a-url" });

    expect(html).not.toContain("<img");
    expect(html).toContain(">LaunchFlow</span>");
  });
});

describe("renderBrandedEmail variants", () => {
  it("renders the internal variant narrower for owner notifications", () => {
    const { html } = renderBrandedEmail({ ...BASE, variant: "internal" });

    expect(html).toContain("max-width:520px");
    expect(html).not.toContain("max-width:600px");
  });

  it("takes trusted bodyHtml only when no paragraphs are given", () => {
    const withBoth = renderBrandedEmail({ ...BASE, bodyHtml: "<p>trusted</p>" });
    expect(withBoth.html).not.toContain("<p>trusted</p>");

    const withoutParagraphs: BrandedEmailInput = { ...BASE };
    delete withoutParagraphs.paragraphs;
    const htmlOnly = renderBrandedEmail({ ...withoutParagraphs, bodyHtml: "<p>trusted</p>" });
    expect(htmlOnly.html).toContain("<p>trusted</p>");
  });

  it("renders a footer note under a rule", () => {
    const { html, text } = renderBrandedEmail({ ...BASE, footerNote: "Reply to this email to add to the case." });

    expect(html).toContain("Reply to this email to add to the case.");
    expect(text).toContain("Reply to this email to add to the case.");
  });
});

describe("escapeHtml", () => {
  it("escapes the ampersand once, not twice", () => {
    expect(escapeHtml("Tom & Jerry <b>")).toBe("Tom &amp; Jerry &lt;b&gt;");
  });
});

describe("paragraphsFromBody", () => {
  it("splits on blank lines and trims", () => {
    expect(paragraphsFromBody("One\n\n  Two  \n\n\nThree")).toEqual(["One", "Two", "Three"]);
  });

  it("drops a paragraph that is nothing but the CTA url, so the link is not shown twice", () => {
    const body = "LaunchFlow has replied to your support case.\n\nhttps://os.launchflow.test/portal/support/abc";

    expect(paragraphsFromBody(body, "https://os.launchflow.test/portal/support/abc")).toEqual([
      "LaunchFlow has replied to your support case.",
    ]);
  });

  it("keeps a paragraph that merely contains the url", () => {
    const body = "See https://os.launchflow.test/portal/support/abc for the reply.";

    expect(paragraphsFromBody(body, "https://os.launchflow.test/portal/support/abc")).toEqual([body]);
  });
});
