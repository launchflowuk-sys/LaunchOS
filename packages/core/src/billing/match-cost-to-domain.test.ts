import { describe, expect, it } from "vitest";
import { matchCostToDomain, tldFromProduct, tldOfDomain, type MatchableDomain } from "./match-cost-to-domain.js";

const at = (iso: string) => new Date(iso);

const domain = (over: Partial<MatchableDomain> & { name: string }): MatchableDomain => ({
  id: `d-${over.name}`,
  clientId: `c-${over.name}`,
  registeredAt: at("2026-04-12T19:19:37Z"),
  ...over,
});

describe("tldFromProduct", () => {
  it("reads both spellings the supplier uses, and refuses everything else", () => {
    expect(tldFromProduct(".CO.UK Domain")).toBe("co.uk");
    expect(tldFromProduct(".LIVE Domain")).toBe("live");
    expect(tldFromProduct("Domain .cab")).toBe("cab");
    expect(tldFromProduct("Starter Business Email")).toBeNull();
    expect(tldFromProduct("Business Web Hosting")).toBeNull();
    expect(tldFromProduct("Reach 100")).toBeNull();
  });
});

describe("tldOfDomain", () => {
  it("keeps every label after the first, so co.uk does not read as uk", () => {
    expect(tldOfDomain("graystowntaxis.co.uk")).toBe("co.uk");
    expect(tldOfDomain("cabio.live")).toBe("live");
  });
});

describe("matchCostToDomain", () => {
  const cabline = domain({ name: "graystowntaxis.co.uk", registeredAt: at("2026-04-12T19:19:37Z") });
  const other = domain({ name: "mooderaboutique.co.uk", registeredAt: at("2026-08-18T21:44:26Z") });

  it("picks the .co.uk bought in the same checkout, out of several", () => {
    const match = matchCostToDomain({ name: ".CO.UK Domain", startedAt: at("2026-04-12T19:19:35Z") }, [cabline, other]);
    expect(match).toEqual({ domainId: cabline.id, clientId: cabline.clientId, confidence: "exact" });
  });

  // The whole reason the TLD alone was not enough, and the reason it is still
  // required: four things can be bought in one checkout.
  it("will not hand a .com line to a .co.uk domain bought in the same checkout", () => {
    const com = domain({ name: "example.com", registeredAt: at("2026-04-12T19:19:35Z") });
    const match = matchCostToDomain({ name: ".COM Domain", startedAt: at("2026-04-12T19:19:37Z") }, [cabline, com]);
    expect(match?.domainId).toBe(com.id);
  });

  it("refuses when two domains of the same TLD were bought in the same minute", () => {
    const a = domain({ name: "one.co.uk", registeredAt: at("2026-04-12T19:19:30Z") });
    const b = domain({ name: "two.co.uk", registeredAt: at("2026-04-12T19:19:40Z") });
    expect(matchCostToDomain({ name: ".CO.UK Domain", startedAt: at("2026-04-12T19:19:35Z") }, [a, b])).toBeNull();
  });

  it("refuses a domain registered on another day entirely", () => {
    expect(matchCostToDomain({ name: ".CO.UK Domain", startedAt: at("2026-04-13T19:19:35Z") }, [cabline])).toBeNull();
  });

  it("offers a mailbox to the domain bought the same day, marked as the guess it is", () => {
    const match = matchCostToDomain({ name: "Starter Business Email", startedAt: at("2026-08-18T09:00:00Z") }, [cabline, other]);
    expect(match).toEqual({ domainId: other.id, clientId: other.clientId, confidence: "same_day" });
  });

  it("refuses a mailbox when two domains were bought that day", () => {
    const a = domain({ name: "one.co.uk", registeredAt: at("2026-08-18T09:00:00Z") });
    const b = domain({ name: "two.com", registeredAt: at("2026-08-18T18:00:00Z") });
    expect(matchCostToDomain({ name: "Starter Business Email", startedAt: at("2026-08-18T12:00:00Z") }, [a, b])).toBeNull();
  });

  it("returns nothing rather than guessing when either side has no date", () => {
    expect(matchCostToDomain({ name: ".CO.UK Domain", startedAt: null }, [cabline])).toBeNull();
    expect(matchCostToDomain({ name: ".CO.UK Domain", startedAt: at("2026-04-12T19:19:35Z") }, [
      domain({ name: "undated.co.uk", registeredAt: null }),
    ])).toBeNull();
  });

  it("returns nothing when there are no domains at all", () => {
    expect(matchCostToDomain({ name: ".CO.UK Domain", startedAt: at("2026-04-12T19:19:35Z") }, [])).toBeNull();
  });
});
