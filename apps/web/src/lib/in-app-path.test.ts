import { describe, expect, it } from "vitest";
import { isInAppPath } from "./in-app-path";

describe("isInAppPath", () => {
  it("accepts in-app paths", () => {
    for (const link of [
      "/",
      "/team",
      "/clients/9f1d0d4e-0000-4000-8000-000000000000",
      "/tickets?status=open",
      "/reports/2026-09#summary",
      "/clients/x/support",
    ]) {
      expect(isInAppPath(link), link).toBe(true);
    }
  });

  it("rejects off-site and non-path values", () => {
    for (const link of [
      // protocol-relative: starts with "/" but navigates off-site
      "//evil.example",
      "//evil.example/login",
      "///evil.example",
      // backslash variants Chrome and Safari normalise to the same thing
      "/\\evil.example",
      "\\\\evil.example",
      "/team\\..\\evil",
      // schemes
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "https://evil.example",
      "http://evil.example/team",
      "mailto:someone@evil.example",
      "data:text/html,<script>alert(1)</script>",
      // absolute URL smuggled behind a leading path character
      "/redirect?to=https://evil.example",
      // not a path at all
      "team",
      "",
      " /team",
    ]) {
      expect(isInAppPath(link), link).toBe(false);
    }
  });

  it("rejects null and undefined", () => {
    expect(isInAppPath(null)).toBe(false);
    expect(isInAppPath(undefined)).toBe(false);
  });
});
