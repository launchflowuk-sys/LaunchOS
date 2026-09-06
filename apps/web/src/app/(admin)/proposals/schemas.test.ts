import * as core from "@launchos/core";
import { describe, expect, it } from "vitest";
import {
  AddLineSchema,
  CreateProposalSchema,
  linesOfText,
  MAX_LINE_QUANTITY,
  MAX_UNIT_PENCE,
  PoundsSchema,
  poundsField,
} from "./schemas";

/**
 * `schemas.ts` may not import core — it is pulled into the browser bundle by
 * the line editor, and core's barrel reaches Playwright. So the two ceilings
 * are copied there and held to core's here, where Node can import both.
 */
describe("the copied ceilings", () => {
  it("are still the numbers core enforces", () => {
    expect(MAX_LINE_QUANTITY).toBe(core.MAX_LINE_QUANTITY);
    expect(MAX_UNIT_PENCE).toBe(core.MAX_UNIT_PENCE);
  });
});

/**
 * The line editor asks for pounds because that is what somebody types off an
 * invoice; everything below it is integer pence. This is where the two meet,
 * so it is where a rounding mistake would quietly misprice a proposal.
 */
describe("pounds and pence", () => {
  it("takes pounds and gives back whole pence", () => {
    expect(PoundsSchema.parse("1250")).toBe(125_000);
    expect(PoundsSchema.parse("1250.00")).toBe(125_000);
    expect(PoundsSchema.parse("12.01")).toBe(1201);
    expect(PoundsSchema.parse("0.05")).toBe(5);
    expect(PoundsSchema.parse(" 99.99 ")).toBe(9999);
  });

  it("refuses anything that is not a price", () => {
    for (const bad of ["", "free", "12.345", "-40", "1,250", "£1250"]) {
      expect(PoundsSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("refuses a line past core's per-line ceiling", () => {
    expect(PoundsSchema.safeParse("100001").success).toBe(false);
  });

  it("puts a stored amount back in the field it came from", () => {
    expect(poundsField(125_000)).toBe("1250.00");
    expect(poundsField(5)).toBe("0.05");
    expect(PoundsSchema.parse(poundsField(1201))).toBe(1201);
  });
});

describe("a new proposal", () => {
  const lead = "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d";

  it("reads one picker value as either a lead or a client", () => {
    expect(CreateProposalSchema.parse({ subject: `lead:${lead}`, title: "A website", shape: "one_off" })).toMatchObject({
      subjectKind: "lead",
      subjectId: lead,
    });
    expect(CreateProposalSchema.parse({ subject: `client:${lead}`, title: "A website", shape: "one_off" })).toMatchObject({
      subjectKind: "client",
    });
  });

  it("refuses a picker that was never touched", () => {
    const parsed = CreateProposalSchema.safeParse({ subject: "", title: "A website", shape: "one_off" });
    expect(parsed.success).toBe(false);
  });
});

describe("scope textareas", () => {
  it("turns one-per-line text into the list core stores, blanks dropped", () => {
    expect(linesOfText("Five-page website\n\n  Hosting  \nBackups\n")).toEqual(["Five-page website", "Hosting", "Backups"]);
    expect(linesOfText(undefined)).toEqual([]);
    expect(linesOfText("   ")).toEqual([]);
  });
});

describe("a priced line", () => {
  const base = { proposalId: "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d", kind: "monthly", description: "Hosting", quantity: "1", unitPence: "250" };

  it("carries the price through as pence", () => {
    expect(AddLineSchema.parse(base)).toMatchObject({ unitPence: 25_000, quantity: 1 });
  });

  it("refuses a line with nothing written on it", () => {
    expect(AddLineSchema.safeParse({ ...base, description: "" }).success).toBe(false);
  });
});
