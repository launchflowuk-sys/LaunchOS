import { describe, expect, it } from "vitest";
import {
  ATTRIBUTION_COOKIE,
  attributionCookieString,
  attributionFromVisit,
  decodeAttribution,
  encodeAttribution,
  externalReferrerHost,
  hasAttribution,
  readCookieValue,
} from "./attribution";

const OWN = ["launchflow.co.uk", "os.launchflow.co.uk"];

describe("attributionFromVisit", () => {
  it("reads the UTM tags and click ids off the URL, plus the landing path", () => {
    const attribution = attributionFromVisit({
      search: "?utm_source=google&utm_medium=cpc&utm_campaign=spring-launch&utm_term=taxi+website&utm_content=ad-a&gclid=abc123",
      pathname: "/pricing",
      referrer: "https://www.google.com/",
      ownHosts: OWN,
    });
    expect(attribution).toEqual({
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "spring-launch",
      utmTerm: "taxi website",
      utmContent: "ad-a",
      gclid: "abc123",
      referrer: "www.google.com",
      landingPath: "/pricing",
    });
  });

  it("records nothing for a direct visit, so no cookie is written", () => {
    const attribution = attributionFromVisit({ search: "", pathname: "/", referrer: "", ownHosts: OWN });
    expect(attribution).toEqual({});
    expect(hasAttribution(attribution)).toBe(false);
  });

  it("ignores a referrer on our own hosts and keeps only the host of an external one", () => {
    expect(externalReferrerHost("https://launchflow.co.uk/pricing?x=1", OWN)).toBeUndefined();
    expect(externalReferrerHost("https://www.launchflow.co.uk/", OWN)).toBeUndefined();
    expect(externalReferrerHost("https://t.co/abc?secret=1", OWN)).toBe("t.co");
    expect(externalReferrerHost("not a url", OWN)).toBeUndefined();
    const fromFacebook = attributionFromVisit({ search: "?fbclid=xyz", pathname: "/", referrer: "https://l.facebook.com/l.php?u=…", ownHosts: OWN });
    expect(fromFacebook).toEqual({ fbclid: "xyz", referrer: "l.facebook.com", landingPath: "/" });
  });

  it("clips every value to the caps core applies", () => {
    const long = "x".repeat(600);
    const attribution = attributionFromVisit({ search: `?utm_source=${long}`, pathname: `/${long}`, ownHosts: OWN });
    expect(attribution.utmSource).toHaveLength(200);
    expect(attribution.landingPath).toHaveLength(500);
  });
});

describe("cookie round trip", () => {
  it("encodes to a header-safe value and decodes back to the same object", () => {
    const attribution = { utmSource: "google", utmCampaign: "spring, launch", landingPath: "/work?ref=\"x\"" };
    const encoded = encodeAttribution(attribution);
    expect(encoded).not.toMatch(/[;,"\s]/);
    expect(decodeAttribution(encoded)).toEqual(attribution);
  });

  it("reads an empty object for a missing, corrupt or hand-edited cookie", () => {
    expect(decodeAttribution(null)).toEqual({});
    expect(decodeAttribution("%7Bnot-json")).toEqual({});
    expect(decodeAttribution(encodeURIComponent("[1,2]"))).toEqual({});
    expect(decodeAttribution(encodeURIComponent(JSON.stringify({ email: "a@b.c", utmSource: 5, utmMedium: "cpc" })))).toEqual({ utmMedium: "cpc" });
  });

  it("writes a thirty-day, SameSite=Lax cookie on the root path, Secure only over https", () => {
    const plain = attributionCookieString({ utmSource: "google" }, false);
    expect(plain.startsWith(`${ATTRIBUTION_COOKIE}=`)).toBe(true);
    expect(plain).toContain("Max-Age=2592000");
    expect(plain).toContain("SameSite=Lax");
    expect(plain).toContain("Path=/");
    expect(plain).not.toContain("Secure");
    expect(attributionCookieString({ utmSource: "google" }, true)).toContain("; Secure");
  });

  it("finds one cookie's value in a document.cookie string", () => {
    const value = encodeAttribution({ utmSource: "bing" });
    expect(readCookieValue(`a=1; ${ATTRIBUTION_COOKIE}=${value}; b=2`, ATTRIBUTION_COOKIE)).toBe(value);
    expect(readCookieValue("a=1; b=2", ATTRIBUTION_COOKIE)).toBeNull();
  });
});
