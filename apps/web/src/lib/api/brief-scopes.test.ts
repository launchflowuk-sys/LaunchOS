import { describe, expect, it } from "vitest";
import type { OpsMetricsSnapshot, PermissionKey } from "@launchos/core";
import { scopeBrief } from "./brief-scopes";

/**
 * A snapshot whose every section is identifiable, so a routing mistake shows up
 * as the wrong marker rather than as a plausible-looking number.
 */
const SNAPSHOT = {
  window: { from: new Date("2026-09-07T00:00:00Z"), to: new Date("2026-09-08T00:00:00Z"), hours: 24 },
  cases: "cases-marker",
  tasks: "tasks-marker",
  incidents: "incidents-marker",
  leads: "leads-marker",
  projects: "projects-marker",
  content: "content-marker",
  invoices: "invoices-marker",
  packages: "packages-marker",
  approvals: "approvals-marker",
  agents: "agents-marker",
  team: "team-marker",
} as unknown as OpsMetricsSnapshot;

const ALL: PermissionKey[] = ["support", "content", "billing", "settings", "approvals", "access"];

describe("what a token is allowed to see in the brief", () => {
  it("gives every section to a token holding every permission", () => {
    const brief = scopeBrief(SNAPSHOT, ALL);
    expect(brief.omitted).toEqual([]);
    expect(Object.keys(brief.sections).sort()).toEqual(
      ["agents", "approvals", "cases", "content", "incidents", "invoices", "leads", "packages", "projects", "tasks", "team"],
    );
  });

  it("gives a token with no scopes nothing but the window", () => {
    const brief = scopeBrief(SNAPSHOT, []);
    expect(brief.sections).toEqual({});
    expect(brief.window).toEqual(SNAPSHOT.window);
    // Useless, and correctly so: a credential nobody scoped should read
    // nothing rather than quietly read everything.
    expect(brief.omitted.length).toBeGreaterThan(0);
  });

  it("always includes the window, which is context rather than data", () => {
    for (const scopes of [[], ["support"], ALL] as PermissionKey[][]) {
      expect(scopeBrief(SNAPSHOT, scopes).window).toEqual(SNAPSHOT.window);
    }
  });

  it.each([
    ["support", ["cases", "tasks", "incidents", "leads", "projects"]],
    ["content", ["content"]],
    ["billing", ["invoices", "packages"]],
    ["approvals", ["approvals"]],
    ["settings", ["agents", "team"]],
  ])("gives %s exactly its own sections and nothing else", (scope, expected) => {
    const brief = scopeBrief(SNAPSHOT, [scope as PermissionKey]);
    expect(Object.keys(brief.sections).sort()).toEqual([...expected].sort());
  });

  it("routes each section to the right marker, so a mix-up cannot hide", () => {
    const brief = scopeBrief(SNAPSHOT, ALL);
    for (const [name, value] of Object.entries(brief.sections)) {
      expect(value).toBe(`${name}-marker`);
    }
  });

  it("names what it withheld, because absence must never read as zero", () => {
    // The failure this prevents: a billing-only token gets a brief with no
    // `cases`, and an assistant reports a quiet morning during an outage.
    const brief = scopeBrief(SNAPSHOT, ["billing"]);
    expect(brief.omitted).toContain("cases");
    expect(brief.omitted).toContain("incidents");
    expect(brief.omitted).not.toContain("invoices");
  });

  it("accounts for every section exactly once, either shown or named as withheld", () => {
    for (const scopes of [[], ["support"], ["billing", "content"], ALL] as PermissionKey[][]) {
      const brief = scopeBrief(SNAPSHOT, scopes);
      const shown = Object.keys(brief.sections);
      expect([...shown, ...brief.omitted].sort()).toEqual(
        ["agents", "approvals", "cases", "content", "incidents", "invoices", "leads", "packages", "projects", "tasks", "team"],
      );
      // Nothing is both shown and withheld.
      expect(shown.filter((name) => (brief.omitted as string[]).includes(name))).toEqual([]);
    }
  });

  it("grants nothing for the access permission — a count of credentials is still a fact about credentials", () => {
    expect(scopeBrief(SNAPSHOT, ["access"]).sections).toEqual({});
  });
});
