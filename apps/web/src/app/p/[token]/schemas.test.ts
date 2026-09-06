import { SIGNATURE_VIEWBOX } from "@launchos/core";
import { describe, expect, it } from "vitest";
import { AcceptSchema, DeclineSchema } from "./schemas";

/**
 * The public page is one of three places a stranger can write to this app, so
 * what it refuses matters more than what it accepts.
 */
describe("the public proposal form", () => {
  const good = {
    token: "8Kd2mQ1xTn0Zr7Lb4Vc9Ws6Yh3Uj5Ge",
    name: "Shumaila Khan",
    email: "shumaila@example.co.uk",
    signature: "M12 40 L80.5 22 L140 61",
    terms: "on",
  };

  it("takes a name, an email, drawn path data and the tick", () => {
    const parsed = AcceptSchema.safeParse(good);
    expect(parsed.success).toBe(true);
  });

  it("refuses an unticked box, because a tick is what the acceptance rests on", () => {
    const parsed = AcceptSchema.safeParse({ ...good, terms: "" });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe("Please tick to agree to the terms");
  });

  it("refuses an unsigned form", () => {
    expect(AcceptSchema.safeParse({ ...good, signature: "" }).error?.issues[0]?.message).toBe("Please sign in the box above");
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
      expect(AcceptSchema.safeParse({ ...good, signature: attack }).success, attack).toBe(false);
    }
  });

  it("refuses a token that is not token-shaped, before any query is issued", () => {
    for (const token of ["", "short", "has spaces in it and is long enough", "../../etc/passwd-and-more"]) {
      expect(AcceptSchema.safeParse({ ...good, token }).success, token).toBe(false);
      expect(DeclineSchema.safeParse({ token }).success, token).toBe(false);
    }
  });

  it("lets a decline arrive with no reason at all", () => {
    const parsed = DeclineSchema.safeParse({ token: good.token, reason: "" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.reason).toBeUndefined();
  });

  /** The canvas normalises to this box; if core's changes, the pad has to follow. */
  it("draws in the box core stores signatures in", () => {
    expect(SIGNATURE_VIEWBOX).toBe("0 0 600 200");
  });
});
