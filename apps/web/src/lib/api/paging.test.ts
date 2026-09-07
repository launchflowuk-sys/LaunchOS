import { describe, expect, it } from "vitest";
import { DEFAULT_LIMIT, MAX_LIMIT, parseEnumParam, parsePaging } from "./paging";

const q = (search: string) => new URLSearchParams(search);

describe("parsePaging", () => {
  it("defaults when nothing is asked for", () => {
    expect(parsePaging(q(""))).toEqual({ ok: true, limit: DEFAULT_LIMIT, offset: 0 });
  });

  it("takes a sensible limit and offset", () => {
    expect(parsePaging(q("limit=10&offset=20"))).toEqual({ ok: true, limit: 10, offset: 20 });
  });

  it("treats an empty parameter as absent, which is what a client's own template does", () => {
    expect(parsePaging(q("limit=&offset="))).toEqual({ ok: true, limit: DEFAULT_LIMIT, offset: 0 });
  });

  it.each([
    ["above the cap", `limit=${MAX_LIMIT + 1}`],
    ["zero", "limit=0"],
    ["negative", "limit=-5"],
    ["fractional", "limit=2.5"],
    ["not a number", "limit=abc"],
  ])("refuses a limit that is %s rather than quietly substituting one", (_label, search) => {
    const result = parsePaging(q(search));
    expect(result.ok).toBe(false);
    // The failure this prevents: a caller asks for 500, is given 50, and has
    // no way to know it only saw part of the answer.
    if (!result.ok) expect(result.message).toContain(String(MAX_LIMIT));
  });

  it.each([["negative", "offset=-1"], ["fractional", "offset=1.5"], ["not a number", "offset=x"]])(
    "refuses an offset that is %s",
    (_label, search) => {
      expect(parsePaging(q(search)).ok).toBe(false);
    },
  );

  it("allows the cap exactly", () => {
    expect(parsePaging(q(`limit=${MAX_LIMIT}`))).toEqual({ ok: true, limit: MAX_LIMIT, offset: 0 });
  });
});

describe("parseEnumParam", () => {
  const allowed = ["open", "resolved"] as const;

  it("absent means no filter", () => {
    expect(parseEnumParam(null, allowed)).toEqual({ ok: true, value: undefined });
    expect(parseEnumParam("", allowed)).toEqual({ ok: true, value: undefined });
  });

  it("passes a known value through", () => {
    expect(parseEnumParam("open", allowed)).toEqual({ ok: true, value: "open" });
  });

  it("refuses a typo instead of ignoring it", () => {
    // `?status=pendign` silently returning every row is how a caller comes to
    // believe a filter is applied when it is not, and acts on the wrong list.
    const result = parseEnumParam("opne", allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("open, resolved");
  });

  it("is case sensitive, because the database values are", () => {
    expect(parseEnumParam("OPEN", allowed).ok).toBe(false);
  });
});
