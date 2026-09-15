import { describe, expect, it } from "vitest";
import { blogDeliveryFor, blogPostSlug } from "./blog-delivery.js";

describe("blogDeliveryFor", () => {
  /**
   * WordPress owns its own content, so a post is pushed into it and lives
   * there. Everything else — the Next.js applications on Coolify, which is
   * most of the estate — is served from LaunchOS and fetches what it needs,
   * so there is nothing to push and no credential to hold.
   */
  it("pushes to WordPress and serves everything else", () => {
    expect(blogDeliveryFor("wordpress")).toBe("push");
    expect(blogDeliveryFor("nextjs")).toBe("pull");
    expect(blogDeliveryFor("static")).toBe("pull");
    expect(blogDeliveryFor("other")).toBe("pull");
  });
});

describe("blogPostSlug", () => {
  it("makes a readable slug from the title", () => {
    expect(blogPostSlug("Five signs your windows need replacing", "0f8c1d2e-aaaa-bbbb-cccc-ddddeeeeffff"))
      .toBe("five-signs-your-windows-need-replacing-0f8c1d2e");
  });

  /**
   * The id suffix is not decoration. Two posts in different months can carry
   * the same title — "October offers", "November offers" is the exception, not
   * the rule — and a slug collision would make one post unreachable.
   */
  it("distinguishes two posts that share a title", () => {
    const a = blogPostSlug("Winter offer", "11111111-2222-3333-4444-555555555555");
    const b = blogPostSlug("Winter offer", "99999999-8888-7777-6666-555555555555");
    expect(a).not.toBe(b);
    expect(a.startsWith("winter-offer-")).toBe(true);
  });

  it("strips punctuation, accents and runs of separators", () => {
    expect(blogPostSlug("  Don't  DIY  it — really!  ", "abcdef01-0000-0000-0000-000000000000"))
      .toBe("don-t-diy-it-really-abcdef01");
    expect(blogPostSlug("Café & Crème", "abcdef01-0000-0000-0000-000000000000"))
      .toBe("cafe-creme-abcdef01");
  });

  /**
   * A blog post is allowed to have no title — the writer gives one, but a
   * hand-made item might not — and it still has to be addressable.
   */
  it("falls back to the id alone when there is no usable title", () => {
    expect(blogPostSlug(null, "abcdef01-0000-0000-0000-000000000000")).toBe("post-abcdef01");
    expect(blogPostSlug("   ", "abcdef01-0000-0000-0000-000000000000")).toBe("post-abcdef01");
    expect(blogPostSlug("!!!", "abcdef01-0000-0000-0000-000000000000")).toBe("post-abcdef01");
  });

  /** Long titles are trimmed so a URL stays a URL, without cutting mid-word. */
  it("keeps a long title to a sensible length and never ends on a separator", () => {
    const slug = blogPostSlug(
      "Everything you ever wanted to know about double glazing and the many reasons it matters to your heating bill",
      "abcdef01-0000-0000-0000-000000000000",
    );
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-abcdef01")).toBe(true);
    expect(slug).not.toMatch(/--/);
  });

  /** The same post always gets the same address; a slug is a permanent link. */
  it("is deterministic", () => {
    const args = ["Ten tips", "abcdef01-0000-0000-0000-000000000000"] as const;
    expect(blogPostSlug(...args)).toBe(blogPostSlug(...args));
  });
});
