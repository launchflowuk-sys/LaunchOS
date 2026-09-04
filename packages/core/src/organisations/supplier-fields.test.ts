import { describe, expect, it } from "vitest";
import { CountryField, PostcodeField, VatNumberField, isVatNumberShaped } from "./supplier-fields.js";

describe("isVatNumberShaped", () => {
  it("accepts UK and EU registrations", () => {
    expect(isVatNumberShaped("GB123456789")).toBe(true);
    expect(isVatNumberShaped("GB123456789012")).toBe(true);
    expect(isVatNumberShaped("GB 123 456 789")).toBe(true);
    expect(isVatNumberShaped("IE1234567FA")).toBe(true);
    expect(isVatNumberShaped("ATU12345678")).toBe(true);
  });

  it("rejects the typos and pastes a length cap lets through", () => {
    expect(isVatNumberShaped("GB12345678")).toBe(false);
    expect(isVatNumberShaped("GB1234567890")).toBe(false);
    expect(isVatNumberShaped("VAT GB123456789")).toBe(false);
    expect(isVatNumberShaped("123456789")).toBe(false);
    expect(isVatNumberShaped("GB")).toBe(false);
  });
});

describe("VatNumberField", () => {
  it("stores a registration compact and uppercased", () => {
    expect(VatNumberField.parse(" gb 123 456 789 ")).toBe("GB123456789");
  });

  it("treats blank as clearing the column", () => {
    expect(VatNumberField.parse("")).toBeNull();
    expect(VatNumberField.parse("   ")).toBeNull();
    expect(VatNumberField.parse(null)).toBeNull();
  });

  it("refuses a malformed number with a message naming the shape", () => {
    const result = VatNumberField.safeParse("GB12345678");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/GB123456789/);
  });
});

describe("CountryField", () => {
  it("takes an ISO alpha-2 code and uppercases it", () => {
    expect(CountryField.parse(" gb ")).toBe("GB");
    expect(CountryField.parse("")).toBeNull();
  });

  it("refuses a country name", () => {
    expect(CountryField.safeParse("United Kingdom").success).toBe(false);
    expect(CountryField.safeParse("G").success).toBe(false);
  });
});

describe("PostcodeField", () => {
  it("keeps a trimmed postcode of a plausible length", () => {
    expect(PostcodeField.parse("  RM17 6AA ")).toBe("RM17 6AA");
    expect(PostcodeField.parse("")).toBeNull();
  });

  it("refuses one too short or too long to be a postcode", () => {
    expect(PostcodeField.safeParse("RM").success).toBe(false);
    expect(PostcodeField.safeParse("RM17 6AA RM17 6AA").success).toBe(false);
  });
});
