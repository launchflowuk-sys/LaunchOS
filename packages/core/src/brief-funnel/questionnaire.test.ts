import { describe, expect, it } from "vitest";
import {
  activeAnswers, canSubmit, excludedAnswerKeys, FIELDS_BY_KEY,
  isFieldActive, satisfiedSteps, STAGES, stageFor, validateStep,
} from "./questionnaire.js";

describe("the definition itself", () => {
  it("has eight stages, numbered one to eight", () => {
    expect(STAGES).toHaveLength(8);
    expect(STAGES.map((s) => s.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  /**
   * A duplicate key would mean two questions writing to one answer, and the
   * brief reading whichever won. Cheap to check, impossible to spot by eye.
   */
  it("has no duplicate field keys across stages", () => {
    const keys = STAGES.flatMap((s) => s.fields.map((f) => f.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("points every conditional field at a field that exists", () => {
    for (const [, field] of FIELDS_BY_KEY) {
      if (!field.showWhen) continue;
      expect(FIELDS_BY_KEY.has(field.showWhen.key), `${field.key} depends on ${field.showWhen.key}`).toBe(true);
    }
  });

  it("gives every choice field its options", () => {
    for (const [, field] of FIELDS_BY_KEY) {
      if (["single", "multi", "chips", "select"].includes(field.kind)) {
        expect(field.options?.length, `${field.key} has no options`).toBeGreaterThan(0);
      }
    }
  });

  it("finds a stage by number and nothing by a number that is not one", () => {
    expect(stageFor(1)?.key).toBe("contact");
    expect(stageFor(9)).toBeUndefined();
  });
});

describe("validateStep", () => {
  /** The whole point of step one: a name and one way to reach them. */
  it("lets step one through on a name and a phone alone", () => {
    expect(validateStep(1, { name: "Sam", phone: "07700900123" }).ok).toBe(true);
  });

  it("lets step one through on a name and an email alone", () => {
    expect(validateStep(1, { name: "Sam", email: "sam@example.com" }).ok).toBe(true);
  });

  it("does not demand an address to move on", () => {
    const result = validateStep(1, { name: "Sam", phone: "07700900123" });
    expect(result.errors.addressLine1).toBeUndefined();
    expect(result.errors.postcode).toBeUndefined();
  });

  it("refuses a name with no way of reaching anybody", () => {
    const result = validateStep(1, { name: "Sam" });
    expect(result.ok).toBe(false);
    expect(result.errors.email).toMatch(/email or a phone/);
  });

  it("catches an email that is not one", () => {
    const result = validateStep(1, { name: "Sam", email: "sam@" });
    expect(result.ok).toBe(false);
    expect(result.errors.email).toMatch(/does not look right/);
  });

  it("names the field that is missing, so the error can sit beside it", () => {
    const result = validateStep(2, { industry: "Plumbing" });
    expect(result.ok).toBe(false);
    expect(result.errors.business).toContain("Business name");
  });

  it("wants at least one goal", () => {
    expect(validateStep(3, { goals: [] }).ok).toBe(false);
    expect(validateStep(3, { goals: ["enquiries"] }).ok).toBe(true);
  });

  /** A hidden question cannot hold anybody up. */
  it("does not require a conditional field that is not showing", () => {
    expect(validateStep(5, { pages: ["home"] }).ok).toBe(true);
  });

  it("refuses a step that does not exist", () => {
    expect(validateStep(99, {}).ok).toBe(false);
  });
});

describe("conditional fields", () => {
  const shopCount = FIELDS_BY_KEY.get("shopProductCount")!;
  const redesign = FIELDS_BY_KEY.get("redesignKeep")!;

  it("shows the shop questions only when selling online was chosen", () => {
    expect(isFieldActive(shopCount, { goals: ["enquiries"] })).toBe(false);
    expect(isFieldActive(shopCount, { goals: ["enquiries", "sales"] })).toBe(true);
  });

  /** `"*"` means any answer — the redesign questions appear because a URL exists. */
  it("shows the redesign questions for any website address at all", () => {
    expect(isFieldActive(redesign, {})).toBe(false);
    expect(isFieldActive(redesign, { websiteUrl: "" })).toBe(false);
    expect(isFieldActive(redesign, { websiteUrl: "https://taylorplumbing.co.uk" })).toBe(true);
  });

  it("treats an unconditional field as always active", () => {
    expect(isFieldActive(FIELDS_BY_KEY.get("business")!, {})).toBe(true);
  });
});

describe("activeAnswers", () => {
  /**
   * Deselecting a goal must not lose the typing, and must not leave a stale
   * requirement in the brief either. Both halves matter.
   */
  it("drops answers whose question is no longer showing", () => {
    const answers = { goals: ["enquiries"], shopProductCount: "About 40", business: "Taylor Plumbing" };

    const active = activeAnswers(answers);

    expect(active.shopProductCount).toBeUndefined();
    expect(active.business).toBe("Taylor Plumbing");
    // Still in the draft, so reselecting Sell online gets the answer back.
    expect(answers.shopProductCount).toBe("About 40");
  });

  it("keeps them when the question is showing", () => {
    const active = activeAnswers({ goals: ["sales"], shopProductCount: "About 40" });
    expect(active.shopProductCount).toBe("About 40");
  });

  it("passes through answers it has no field for", () => {
    // Answers written by an older questionnaire version must not vanish.
    expect(activeAnswers({ somethingRetired: "kept" }).somethingRetired).toBe("kept");
  });

  it("lists what was excluded, so review can explain it", () => {
    expect(excludedAnswerKeys({ goals: ["enquiries"], shopProductCount: "40" })).toEqual(["shopProductCount"]);
    expect(excludedAnswerKeys({ goals: ["sales"], shopProductCount: "40" })).toEqual([]);
  });
});

describe("satisfiedSteps", () => {
  it("reports the steps the answers meet the requirements of", () => {
    const answers = {
      name: "Sam", phone: "07700900123",
      business: "Taylor Plumbing", industry: "Plumbing",
      goals: ["enquiries"],
    };

    // 4 needs a design direction, 5 needs pages, 7 needs budget and timeline.
    // 6 has nothing required, which is why this is not the progress bar.
    expect(satisfiedSteps(answers)).toEqual([1, 2, 3, 6]);
  });
});

describe("canSubmit", () => {
  const complete = {
    name: "Sam", phone: "07700900123",
    business: "Taylor Plumbing", industry: "Plumbing",
    goals: ["enquiries"], designDirection: "clean",
    pages: ["home", "contact"], budget: "1500_3000", timeline: ["asap"],
  };

  it("allows a brief with every requirement met", () => {
    expect(canSubmit(complete).ok).toBe(true);
  });

  it("refuses an empty draft and says which fields are missing", () => {
    const result = canSubmit({});
    expect(result.ok).toBe(false);
    expect(Object.keys(result.errors)).toEqual(
      expect.arrayContaining(["name", "business", "industry", "goals", "designDirection", "pages", "budget", "timeline"]),
    );
  });

  /** A client claiming it finished every step is exactly what must not be trusted. */
  it("refuses when one late stage is unanswered", () => {
    const { budget, ...missingBudget } = complete;
    expect(canSubmit(missingBudget).ok).toBe(false);
    expect(canSubmit(missingBudget).errors.budget).toBeDefined();
  });
});
