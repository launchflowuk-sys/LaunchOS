import { describe, expect, it } from "vitest";
import { markdownToSafeHtml } from "./markdown.js";

describe("markdownToSafeHtml", () => {
  it("renders headings, paragraphs and both kinds of list", () => {
    const html = markdownToSafeHtml(
      ["# Contact us", "", "Call the office on 01375 000000.", "", "- Mon to Fri", "- Weekends by arrangement", "", "1. Ring", "2. Book"].join("\n"),
    );
    expect(html).toBe(
      [
        "<h1>Contact us</h1>",
        "",
        "<p>Call the office on 01375 000000.</p>",
        "",
        "<ul>\n  <li>Mon to Fri</li>\n  <li>Weekends by arrangement</li>\n</ul>",
        "",
        "<ol>\n  <li>Ring</li>\n  <li>Book</li>\n</ol>",
      ].join("\n"),
    );
  });

  it("joins the lines of one paragraph and keeps blocks apart", () => {
    expect(markdownToSafeHtml("one\ntwo\n\nthree")).toBe("<p>one two</p>\n\n<p>three</p>");
  });

  it("renders emphasis, strong and code", () => {
    expect(markdownToSafeHtml("**now** and *later* and `code`")).toBe(
      "<p><strong>now</strong> and <em>later</em> and <code>code</code></p>",
    );
  });

  it("leaves markdown syntax inside a code span alone", () => {
    expect(markdownToSafeHtml("use `a * b * c` carefully")).toBe("<p>use <code>a * b * c</code> carefully</p>");
  });

  it("passes no raw HTML through", () => {
    const html = markdownToSafeHtml('<script>alert("x")</script>\n\n<img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders safe links and drops dangerous ones back to their text", () => {
    expect(markdownToSafeHtml("[Book](https://grayscabline.co.uk/book)")).toBe(
      '<p><a href="https://grayscabline.co.uk/book">Book</a></p>',
    );
    expect(markdownToSafeHtml("[Email us](mailto:info@example.com)")).toContain('href="mailto:info@example.com"');
    expect(markdownToSafeHtml("[Prices](/prices)")).toContain('href="/prices"');
    // The url pattern stops at the first `)`, so the stray one survives as
    // text. What matters is that no anchor and no scheme reach the page.
    const dangerous = markdownToSafeHtml("[Click](javascript:alert(1))");
    expect(dangerous).not.toContain("<a ");
    expect(dangerous).not.toContain("javascript:");
    expect(markdownToSafeHtml("[Click](data:text/html;base64,PHN2Zz4=)")).toBe("<p>Click</p>");
    expect(markdownToSafeHtml("[Click](vbscript:msgbox)")).toBe("<p>Click</p>");
  });

  it("does not let a placeholder-shaped draft steal a held link", () => {
    // `<0>` in the source is escaped before placeholders are ever assigned, so
    // it cannot collide with one.
    const html = markdownToSafeHtml("<0> and [Book](/book)");
    expect(html).toBe('<p>&lt;0&gt; and <a href="/book">Book</a></p>');
  });

  it("ignores blank input and stray blank lines", () => {
    expect(markdownToSafeHtml("")).toBe("");
    expect(markdownToSafeHtml("\n\n   \n\n")).toBe("");
    expect(markdownToSafeHtml("a\r\n\r\nb")).toBe("<p>a</p>\n\n<p>b</p>");
  });
});
