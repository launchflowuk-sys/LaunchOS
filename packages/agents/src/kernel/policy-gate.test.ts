import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decide } from "./policy-gate.js";
import { defineTool } from "./types.js";

const safeTool = defineTool({ name: "a", description: "", input: z.object({}), risk: "safe", execute: async () => ({}) });
const riskyTool = defineTool({ name: "b", description: "", input: z.object({}), risk: "requires_approval", execute: async () => ({}) });

describe("decide", () => {
  it("executes safe tools and queues risky tools under the safe policy", () => {
    expect(decide(safeTool, "safe")).toBe("execute");
    expect(decide(riskyTool, "safe")).toBe("queue_approval");
  });
  it("queues everything under approval_all", () => {
    expect(decide(safeTool, "approval_all")).toBe("queue_approval");
    expect(decide(riskyTool, "approval_all")).toBe("queue_approval");
  });
});
