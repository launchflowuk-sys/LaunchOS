/**
 * Holds `reconcile-support-emails.ts` against `@launchos/core`.
 *
 * The script duplicates three things from core — the fallback support domain,
 * the holding client's slug, and the shape a support domain is allowed to take
 * — rather than importing them. That is not an oversight: `@launchos/core` is a
 * **devDependency** of `@launchos/db`, so it is absent from the production
 * image, and the script is a repair tool that has to run *in* that image. An
 * import would make it fail to load precisely when someone reaches for it.
 *
 * What duplication costs is drift, and drift here is expensive: the script
 * rewrites every client's routable address in one transaction, so a fallback
 * domain that no longer matches core's would silently move every backfilled
 * client onto a domain nothing receives mail on, and a holding slug that no
 * longer matches would hand `unmatched@<domain>` a deliverable address and
 * start filing real client mail into the bucket for unroutable mail.
 *
 * So the copies are checked against each other here instead. This is a test,
 * not shipped code, so importing core is free — the production image never
 * loads this file.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SUPPORT_EMAIL_DOMAIN as CORE_DEFAULT_DOMAIN, HOLDING_CLIENT_SLUG as CORE_HOLDING_SLUG, supportEmailDomain } from "@launchos/core";
import {
  DEFAULT_SUPPORT_EMAIL_DOMAIN as SCRIPT_DEFAULT_DOMAIN,
  HOLDING_CLIENT_SLUG as SCRIPT_HOLDING_SLUG,
  resolveDomain,
} from "./reconcile-support-emails.js";

/**
 * Domains the two validators must agree about, accepted and rejected alike.
 * The empty/unset value is deliberately absent: that is the one case where the
 * two are *meant* to differ, and it has a test of its own below.
 */
const CASES = [
  "support.launchflow.co.uk",
  "mail.grayscabline.co.uk",
  "a.io",
  "x-y.example.com",
  "SUPPORT.LAUNCHFLOW.CO.UK",
  "  support.launchflow.co.uk  ",
  "localhost",
  "-leading.example.com",
  "trailing-.example.com",
  "double..dot.com",
  "under_score.example.com",
  "space in.example.com",
  "a.b",
] as const;

/** `undefined` when the validator refused the value; the parsed domain when it took it. */
function accepted(validate: (env: NodeJS.ProcessEnv) => string, raw: string): string | undefined {
  try {
    return validate({ SUPPORT_EMAIL_DOMAIN: raw });
  } catch {
    return undefined;
  }
}

describe("reconcile-support-emails duplicates core exactly", () => {
  it("uses the same fallback support domain", () => {
    expect(SCRIPT_DEFAULT_DOMAIN).toBe(CORE_DEFAULT_DOMAIN);
  });

  it("uses the same holding client slug", () => {
    expect(SCRIPT_HOLDING_SLUG).toBe(CORE_HOLDING_SLUG);
  });

  it("accepts and refuses exactly the domains core does", () => {
    for (const raw of CASES) {
      expect({ raw, domain: accepted((env) => resolveDomain(env, false), raw) })
        .toEqual({ raw, domain: accepted(supportEmailDomain, raw) });
    }
  });

  it("falls back to the same domain core does, but only when asked out loud", () => {
    // core falls back silently on an unset variable; the script refuses, because
    // a mass rewrite is not a place for an implicit default.
    expect(supportEmailDomain({})).toBe(CORE_DEFAULT_DOMAIN);
    expect(() => resolveDomain({}, false)).toThrow(/SUPPORT_EMAIL_DOMAIN is not set/);
    expect(resolveDomain({}, true)).toBe(CORE_DEFAULT_DOMAIN);
  });
});
