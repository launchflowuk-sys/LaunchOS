import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./export-data.js";

describe("csvCell", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvCell("Grays CabLine")).toBe("Grays CabLine");
    expect(csvCell(220)).toBe("220");
  });

  it("writes nothing for null and undefined, rather than the word", () => {
    // "null" in a spreadsheet cell is a value someone will sort on by mistake.
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  /**
   * The three characters that break a CSV. A client called "Smith, Jones & Co"
   * would otherwise silently become two columns and shift every field after it
   * on that row.
   */
  it("quotes a comma so the row does not gain a column", () => {
    expect(csvCell("Smith, Jones & Co")).toBe('"Smith, Jones & Co"');
  });

  it("doubles an inner quote, which is how CSV escapes one", () => {
    expect(csvCell('He said "hello"')).toBe('"He said ""hello"""');
  });

  it("quotes a newline so one record stays one row", () => {
    expect(csvCell("line one\nline two")).toBe('"line one\nline two"');
  });

  it("writes a date as ISO, which every spreadsheet can parse", () => {
    expect(csvCell(new Date("2026-09-09T01:30:00.000Z"))).toBe("2026-09-09T01:30:00.000Z");
  });
});

describe("toCsv", () => {
  it("takes its header from the rows and separates with CRLF", () => {
    const csv = toCsv([{ name: "Grays CabLine", total: "220.00" }]);
    expect(csv).toBe("name,total\r\nGrays CabLine,220.00");
  });

  it("still emits a header when nothing matched", () => {
    // A file with a header and no rows says "nothing matched". An empty file
    // says "something went wrong", and the difference matters to whoever opens it.
    expect(toCsv([], ["name", "total"])).toBe("name,total");
  });

  it("keeps columns aligned when a later row is missing a field", () => {
    const csv = toCsv([{ name: "A", email: "a@x.test" }, { name: "B" } as Record<string, unknown>]);
    expect(csv).toBe("name,email\r\nA,a@x.test\r\nB,");
  });
});
