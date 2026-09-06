import { SIGNATURE_VIEWBOX } from "@launchos/core";
import { describe, expect, it } from "vitest";
import { SignOffSchema } from "./schemas";

/**
 * The sign-off page is a place a stranger can write to this app, so what it
 * refuses matters more than what it accepts. The same cases as
 * `app/p/[token]/schemas.test.ts`, because it is the same boundary.
 */
describe("the public sign-off form", () => {
  const good = {
    token: "8Kd2mQ1xTn0Zr7Lb4Vc9Ws6Yh3Uj5Ge",
    name: "Shumaila Khan",
    email: "shumaila@example.co.uk",
    signature: "M12 40 L80.5 22 L140 61",
    terms: "on",
  };

  it("takes a name, an email, drawn path data and the tick", () => {
    expect(SignOffSchema.safeParse(good).success).toBe(true);
  });

  it("refuses an unticked box, because the tick is what the sign-off rests on", () => {
    const parsed = SignOffSchema.safeParse({ ...good, terms: "" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Please tick to confirm the work is done");
  });

  it("refuses an unsigned form", () => {
    expect(SignOffSchema.safeParse({ ...good, signature: "" }).error?.issues[0]?.message).toBe("Please sign in the box above");
  });

  /**
   * The signature ends up inside a document handed to Chromium. Only the `d`
   * attribute of a path is accepted — there is no character in that grammar
   * that can open a tag — and core checks the same thing again before storing.
   */
  it("refuses anything in the signature that is not SVG path data", () => {
    for (const attack of [
      '<svg onload="alert(1)">',
      'M0 0"/><script>alert(1)</script>',
      "M0 0 L10 10 <!-- -->",
    ]) {
      expect(SignOffSchema.safeParse({ ...good, signature: attack }).success, attack).toBe(false);
    }
  });

  it("refuses a token that is not token-shaped, before any query is issued", () => {
    for (const token of ["", "short", "has spaces in it and is long enough", "../../etc/passwd-and-more"]) {
      expect(SignOffSchema.safeParse({ ...good, token }).success, token).toBe(false);
    }
  });

  /** One pad, one box: if core's viewBox changes, the shared pad has to follow. */
  it("draws in the box core stores signatures in", () => {
    expect(SIGNATURE_VIEWBOX).toBe("0 0 600 200");
  });
});
