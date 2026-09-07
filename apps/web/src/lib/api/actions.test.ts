import { describe, expect, it } from "vitest";
import { agentRegistry, scopedCmsProvider } from "@launchos/agents/definitions";
import { createIntegrations } from "@launchos/integrations";
import { createEmailAdapter } from "@launchos/channels";
import { isRunnableAgent, payloadFor, RUNNABLE_AGENTS, singletonKeyFor, type RunnableAgentKey } from "./actions";

const KEYS = Object.keys(RUNNABLE_AGENTS) as RunnableAgentKey[];

/**
 * The real registry, built the same way `agent-catalog.ts` builds it. Mock-first
 * and constructed only — nothing here runs a tool or opens a connection.
 */
function realAgentKeys(): string[] {
  const registry = agentRegistry({
    integrations: { ...createIntegrations(process.env), cms: scopedCmsProvider(process.env) },
    email: createEmailAdapter(process.env),
    portalBaseUrl: "http://localhost:3000",
  });
  return Object.keys(registry);
}

describe("the agents the API may start", () => {
  it("only names agents that actually exist", () => {
    // The guard against the failure mode an allowlist always has: a key here
    // that was renamed or retired in `packages/agents` would answer 404 for
    // ever, and nothing else would notice.
    const real = realAgentKeys();
    for (const key of KEYS) expect(real).toContain(key);
  });

  it("recognises exactly those keys and nothing else", () => {
    for (const key of KEYS) expect(isRunnableAgent(key)).toBe(true);
    expect(isRunnableAgent("support-triage")).toBe(false);
    expect(isRunnableAgent("nonsense")).toBe(false);
  });

  it("is not fooled by an inherited property name", () => {
    // `key in obj` would say true for these; `Object.hasOwn` does not. A caller
    // POSTing /api/v1/actions/constructor should get a 404, not a crash.
    expect(isRunnableAgent("constructor")).toBe(false);
    expect(isRunnableAgent("toString")).toBe(false);
    expect(isRunnableAgent("__proto__")).toBe(false);
  });

  it("describes each one in words a person could read aloud", () => {
    for (const key of KEYS) {
      expect(RUNNABLE_AGENTS[key].label.length).toBeGreaterThan(0);
      expect(RUNNABLE_AGENTS[key].what.length).toBeGreaterThan(0);
    }
  });
});

describe("payloadFor", () => {
  it("sends the same shape the cron dispatchers send", () => {
    // `ops-brief.ts` and `ads-sentinel.ts` both send `{ now: <iso> }`. A manual
    // run must be the same run — a second shape would be a code path that only
    // executes when a human asks, and so the one least likely to be noticed
    // when it breaks.
    const now = new Date("2026-09-07T22:00:00.000Z");
    for (const key of KEYS) {
      expect(payloadFor(key, now)).toEqual({ now: "2026-09-07T22:00:00.000Z" });
    }
  });
});

describe("singletonKeyFor", () => {
  const org = "11111111-1111-4111-8111-111111111111";

  it("differs from the scheduled run's key, so a manual one is not swallowed", () => {
    // The scheduled keys are per organisation per day. If a manual run reused
    // one, pg-boss would drop it and the caller would be told "queued" while
    // nothing happened.
    const key = singletonKeyFor("ops-brief", org, new Date("2026-09-07T22:00:00Z"));
    expect(key).toContain("api");
    expect(key).toContain(org);
  });

  it("collapses a double-tap into one job", () => {
    // `hasAgentRunInFlight` cannot catch this: it reads `agent_runs`, so it
    // only sees a run the worker has already started. A retry a millisecond
    // later would pass every check and queue a second billed Claude call.
    const a = singletonKeyFor("ops-brief", org, new Date(1_700_000_000_000));
    const b = singletonKeyFor("ops-brief", org, new Date(1_700_000_000_001));
    expect(a).toBe(b);
  });

  it("lets a genuinely later request through", () => {
    const a = singletonKeyFor("ops-brief", org, new Date(1_700_000_000_000));
    const b = singletonKeyFor("ops-brief", org, new Date(1_700_000_000_000 + 61_000));
    expect(a).not.toBe(b);
  });

  it("keeps two organisations apart", () => {
    const now = new Date(1_700_000_000_000);
    const other = "22222222-2222-4222-8222-222222222222";
    expect(singletonKeyFor("ops-brief", org, now)).not.toBe(singletonKeyFor("ops-brief", other, now));
  });

  it("keeps two agents apart", () => {
    const now = new Date(1_700_000_000_000);
    expect(singletonKeyFor("ops-brief", org, now)).not.toBe(singletonKeyFor("ad-performance-sentinel", org, now));
  });
});
