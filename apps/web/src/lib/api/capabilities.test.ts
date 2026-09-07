import { describe, expect, it } from "vitest";
import type { AgentCatalogEntry } from "@/lib/agent-catalog";
import { buildCapabilities, delegabilityOf } from "./capabilities";

const CATALOG: readonly AgentCatalogEntry[] = [
  {
    key: "ops-brief",
    name: "Ops Brief",
    description: "Writes the morning brief.",
    trigger: "0 7 * * * (Europe/London)",
    tools: [
      { name: "ops_metrics_snapshot", requiresApproval: false },
      { name: "ops_save_brief", requiresApproval: false },
    ],
  },
  {
    key: "support-triage",
    name: "Support Triage",
    description: "Reads the inbox.",
    trigger: "on ticket.created",
    tools: [
      { name: "tickets_get", requiresApproval: false },
      { name: "messages_reply_to_client", requiresApproval: true },
    ],
  },
  {
    key: "case-study-writer",
    name: "Case Study Writer",
    description: "Drafts case studies.",
    trigger: "manual",
    tools: [{ name: "case_study_publish", requiresApproval: true }],
  },
];

describe("delegabilityOf", () => {
  it("lets a tool that only touches our own rows run on its own", () => {
    expect(delegabilityOf({ requiresApproval: false })).toBe("automatic");
  });

  it("makes anything approval-gated always ask, which is the safe default", () => {
    // Rule 2. The failure this prevents: a tool added in six months quietly
    // gaining the right to message a client because nobody marked it.
    expect(delegabilityOf({ requiresApproval: true })).toBe("always_asks");
  });
});

describe("buildCapabilities", () => {
  it("reports every agent in the registry, not a list someone maintained", () => {
    const { capabilities } = buildCapabilities(CATALOG, {});
    expect(capabilities.map((c) => c.key)).toEqual(["ops-brief", "support-triage", "case-study-writer"]);
  });

  it("distinguishes never-configured from switched-off", () => {
    const { capabilities } = buildCapabilities(CATALOG, { "ops-brief": true, "support-triage": false });
    const byKey = Object.fromEntries(capabilities.map((c) => [c.key, c]));
    expect(byKey["ops-brief"]!.enabled).toBe(true);
    expect(byKey["support-triage"]!.enabled).toBe(false);
    // Nobody turned this off — it simply arrived after the last look. Saying
    // "off" would be a small lie Shoji might act on.
    expect(byKey["case-study-writer"]!.enabled).toBeNull();
  });

  it("marks every approval-gated tool as always asking", () => {
    const { capabilities } = buildCapabilities(CATALOG, {});
    const gated = capabilities.flatMap((c) => c.tools).filter((t) => t.requiresApproval);
    expect(gated).not.toHaveLength(0);
    expect(gated.every((t) => t.delegability === "always_asks")).toBe(true);
  });

  it("never marks an approval-gated tool automatic, however the catalogue grows", () => {
    // The invariant, asserted over the whole set rather than the three above:
    // if this ever fails, something has been handed the right to act outward
    // without a person.
    const { capabilities } = buildCapabilities(CATALOG, {});
    for (const tool of capabilities.flatMap((c) => c.tools)) {
      if (tool.delegability === "automatic") expect(tool.requiresApproval).toBe(false);
    }
  });

  it("counts what it found, so a reader can sanity-check the shape", () => {
    const { summary } = buildCapabilities(CATALOG, { "ops-brief": true });
    expect(summary).toEqual({ agents: 3, enabled: 1, tools: 5, automatic: 3, alwaysAsks: 2 });
  });

  it("copes with an enablement row for an agent that has since been retired", () => {
    // A stale row must not invent a capability that no longer exists.
    const { capabilities, summary } = buildCapabilities(CATALOG, { "deleted-agent": true });
    expect(capabilities.map((c) => c.key)).not.toContain("deleted-agent");
    expect(summary.agents).toBe(3);
    expect(summary.enabled).toBe(0);
  });

  it("returns an empty, honest answer for an empty registry", () => {
    const { capabilities, summary } = buildCapabilities([], {});
    expect(capabilities).toEqual([]);
    expect(summary).toEqual({ agents: 0, enabled: 0, tools: 0, automatic: 0, alwaysAsks: 0 });
  });
});
