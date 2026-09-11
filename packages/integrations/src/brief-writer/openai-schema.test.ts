import { describe, expect, it } from "vitest";
import { OpenAiBriefWriter } from "./openai.js";
import { briefJsonSchema, dropNulls } from "./openai-schema.js";
import { BriefWriterError, StructuredBrief } from "./types.js";

/** A reply as strict mode sends it: every key present, `null` where the field is optional. */
const REPLY = {
  schemaVersion: "1",
  projectTitle: "Taylor Plumbing website",
  businessSummary: "A plumber in Grays who wants more emergency callouts.",
  targetAudience: "Homeowners in Thurrock",
  goals: ["More emergency callouts"],
  sitemap: [{ path: "/", title: "Home", purpose: "Say what they do", sections: ["Hero"], basis: "stated", sourcePaths: ["pages"] }],
  requirements: [{
    id: "r1", description: "An enquiry form", priority: "must", basis: "stated", sourcePaths: ["features"], acceptanceCriteria: null,
  }],
  design: { direction: "Clean and simple", colours: "Blue", referenceUrls: [], accessibilityNotes: null },
  contentPlan: [],
  integrations: [],
  budgetAndTiming: { statedBudget: "Guidance wanted", statedTiming: "No rush", targetDate: null, isQuote: false },
  openQuestions: [],
  assumptions: [],
  excludedScope: [],
  buildConsiderations: [],
  requiresStaffReview: true,
};

type SchemaNode = Record<string, unknown>;

/** Every schema node, walking only the places a schema can nest — never into property names. */
function nodes(node: unknown, out: SchemaNode[] = []): SchemaNode[] {
  if (!node || typeof node !== "object" || Array.isArray(node)) return out;
  const n = node as SchemaNode;
  out.push(n);
  for (const child of Object.values((n.properties as Record<string, unknown>) ?? {})) nodes(child, out);
  if (n.items) nodes(n.items, out);
  for (const option of (n.anyOf as unknown[]) ?? []) nodes(option, out);
  for (const def of Object.values((n.$defs as Record<string, unknown>) ?? {})) nodes(def, out);
  return out;
}

function allowsNull(node: SchemaNode): boolean {
  if (Array.isArray(node.type)) return node.type.includes("null");
  return ((node.anyOf as SchemaNode[]) ?? []).some((option) => option.type === "null");
}

function property(path: string[]): SchemaNode {
  let node = briefJsonSchema() as SchemaNode;
  for (const key of path) node = (node.properties as Record<string, SchemaNode>)[key]!;
  return node;
}

describe("briefJsonSchema", () => {
  it("closes every object and requires every property, as strict mode demands", () => {
    const objects = nodes(briefJsonSchema()).filter((n) => n.properties);
    expect(objects.length).toBeGreaterThan(5);
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      expect([...(object.required as string[])].sort()).toEqual(Object.keys(object.properties as object).sort());
    }
  });

  it("carries no keyword strict mode would reject", () => {
    const rejected = ["$schema", "minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "const", "default"];
    for (const node of nodes(briefJsonSchema())) {
      for (const keyword of rejected) expect(node, `keyword ${keyword}`).not.toHaveProperty(keyword);
    }
  });

  it("lets an optional field come back as null, and a required one not", () => {
    expect(allowsNull(property(["design", "accessibilityNotes"]))).toBe(true);
    expect(allowsNull(property(["budgetAndTiming", "targetDate"]))).toBe(true);
    expect(allowsNull(property(["design", "direction"]))).toBe(false);
    expect(allowsNull(property(["projectTitle"]))).toBe(false);
  });

  it("states the brief's fixed values as single-value enums", () => {
    expect(property(["schemaVersion"]).enum).toEqual(["1"]);
    expect(property(["budgetAndTiming", "isQuote"]).enum).toEqual([false]);
    expect(property(["requiresStaffReview"]).enum).toEqual([true]);
  });
});

describe("dropNulls", () => {
  it("turns strict mode's nulls back into absent optional fields, without touching the reply it was given", () => {
    expect(StructuredBrief.safeParse(REPLY).success).toBe(false);
    const cleaned = dropNulls(REPLY);
    expect(StructuredBrief.safeParse(cleaned).success).toBe(true);
    expect(REPLY.design.accessibilityNotes).toBeNull();
  });
});

describe("OpenAiBriefWriter", () => {
  function replying(content: unknown, seen: { body?: Record<string, unknown> }): typeof fetch {
    return (async (_url: string, init?: RequestInit) => {
      seen.body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  /**
   * The bug this exists for. The prompt said "matching the supplied schema" and
   * the request supplied none, so the model invented its own shape and every
   * brief failed validation — 109 times in one day on one submission.
   */
  it("sends the brief's own schema in strict mode, and accepts nulls where a field is optional", async () => {
    const seen: { body?: Record<string, unknown> } = {};
    const writer = new OpenAiBriefWriter({ apiKey: "sk-test", model: "some-model", fetchImpl: replying(REPLY, seen) });

    const written = await writer.write({ answers: { business: "Taylor Plumbing" }, reference: "LF-TEST-0001" });

    expect(seen.body?.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "website_brief", strict: true } });
    expect((seen.body?.response_format as { json_schema: { schema: unknown } }).json_schema.schema).toEqual(briefJsonSchema());
    expect(written.structured.projectTitle).toBe("Taylor Plumbing website");
    expect(written.structured.design.accessibilityNotes).toBeUndefined();
    expect(written.model).toBe("some-model");
  });

  it("still refuses a reply that is missing what a brief needs", async () => {
    const writer = new OpenAiBriefWriter({ apiKey: "sk-test", model: "m", fetchImpl: replying({ title: "A website" }, {}) });
    const attempt = writer.write({ answers: {}, reference: "LF-TEST-0002" });
    await expect(attempt).rejects.toBeInstanceOf(BriefWriterError);
    await expect(attempt).rejects.toThrow("the brief writer's reply did not match the schema");
  });
});
