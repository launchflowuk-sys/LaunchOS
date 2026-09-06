import { describe, expect, it } from "vitest";
import type { ProjectPhaseStatus } from "@launchos/db/schema";
import {
  MAX_UNDELIVERED_PERCENT,
  describeProgress,
  projectProgress,
  type ProjectProgressInput,
} from "./progress.js";

/**
 * The number the client reads. Every case below is one they could actually be
 * looking at, and the ones that matter most are the ones where a careless rule
 * would lie: an empty project, a project of skipped phases, and a project that
 * is finished but not signed off.
 */

const REACHED = new Date("2026-09-01T10:00:00Z");

function input(over: Partial<ProjectProgressInput> = {}): ProjectProgressInput {
  return { status: "active", deliveredAt: null, phases: [], milestones: [], ...over };
}

function phases(...statuses: ProjectPhaseStatus[]) {
  return statuses.map((status) => ({ status }));
}

function milestones(...reached: boolean[]) {
  return reached.map((hit) => ({ reachedAt: hit ? REACHED : null }));
}

describe("projectProgress", () => {
  it("is 0% on a project with nothing planned, not 100%", () => {
    const result = projectProgress(input());
    expect(result.percent).toBe(0);
    expect(result.unitsTotal).toBe(0);
    expect(describeProgress(result)).toBe("Not planned out yet.");
  });

  it("counts a phase and a milestone as one unit each, pooled", () => {
    // Six phases and one milestone: reaching the milestone is worth one
    // seventh, not half. A 50/50 split would put this at 50%.
    const result = projectProgress(input({ phases: phases("pending", "pending", "pending", "pending", "pending", "pending"), milestones: milestones(true) }));
    expect(result.unitsDone).toBe(1);
    expect(result.unitsTotal).toBe(7);
    expect(result.percent).toBe(14);
  });

  it("moves on a finished phase", () => {
    const result = projectProgress(input({ phases: phases("done", "active", "pending", "pending", "pending", "pending") }));
    expect(result.percent).toBe(16);
    expect(result.phasesDone).toBe(1);
    expect(describeProgress(result)).toBe("1 of 6 steps done.");
  });

  it("gives an active phase no partial credit", () => {
    const active = projectProgress(input({ phases: phases("active", "pending") }));
    const pending = projectProgress(input({ phases: phases("pending", "pending") }));
    expect(active.percent).toBe(pending.percent);
    expect(active.percent).toBe(0);
  });

  it("leaves a skipped phase out of both totals", () => {
    // The client brought their own design. Four steps remain, one is done.
    const result = projectProgress(input({ phases: phases("done", "skipped", "pending", "pending", "pending") }));
    expect(result.phasesCounted).toBe(4);
    expect(result.percent).toBe(25);
  });

  it("is 0% when every phase is skipped and nothing else is planned", () => {
    const result = projectProgress(input({ phases: phases("skipped", "skipped", "skipped") }));
    expect(result.unitsTotal).toBe(0);
    expect(result.percent).toBe(0);
  });

  it("measures a one-phase project honestly at both ends", () => {
    expect(projectProgress(input({ phases: phases("pending") })).percent).toBe(0);
    expect(projectProgress(input({ phases: phases("done") })).percent).toBe(MAX_UNDELIVERED_PERCENT);
  });

  it("runs on milestones alone when a project has no phases", () => {
    const result = projectProgress(input({ milestones: milestones(true, true, false, false) }));
    expect(result.percent).toBe(50);
    expect(describeProgress(result)).toBe("2 of 4 milestones done.");
  });

  it("never reports 100% before delivery, however many boxes are ticked", () => {
    const result = projectProgress(input({
      phases: phases("done", "done", "done", "done", "done", "done"),
      milestones: milestones(true, true, true),
    }));
    expect(result.unitsDone).toBe(result.unitsTotal);
    expect(result.percent).toBe(MAX_UNDELIVERED_PERCENT);
    expect(result.delivered).toBe(false);
  });

  it("reports 100% once delivered, even with a milestone still open", () => {
    // Care milestones outlive delivery. A client told their site is live must
    // not then be shown 88%.
    const result = projectProgress(input({
      status: "delivered",
      deliveredAt: REACHED,
      phases: phases("done", "done", "done", "done", "done", "pending"),
      milestones: milestones(true, false),
    }));
    expect(result.percent).toBe(100);
    expect(result.delivered).toBe(true);
    expect(result.unitsDone).toBeLessThan(result.unitsTotal);
    expect(describeProgress(result)).toBe("Delivered.");
  });

  it("treats a delivery date as delivery even if the status has drifted", () => {
    expect(projectProgress(input({ status: "active", deliveredAt: REACHED })).percent).toBe(100);
  });

  it("freezes a cancelled project at what was actually done", () => {
    const result = projectProgress(input({
      status: "cancelled",
      phases: phases("done", "done", "pending", "pending"),
      milestones: milestones(false),
    }));
    expect(result.percent).toBe(40);
    expect(result.delivered).toBe(false);
  });

  it("rounds down, so a bar never claims a step that is not finished", () => {
    // Two of three is 66.6…%. Rounding up would read as "two thirds and a bit".
    expect(projectProgress(input({ phases: phases("done", "done", "pending") })).percent).toBe(66);
  });

  it("does not mutate what it is given", () => {
    const given = input({ phases: phases("done", "pending"), milestones: milestones(true) });
    const snapshot = JSON.stringify(given);
    projectProgress(given);
    expect(JSON.stringify(given)).toBe(snapshot);
  });

  it("describes both halves when a project has phases and milestones", () => {
    const result = projectProgress(input({ phases: phases("done", "pending", "skipped"), milestones: milestones(true, false, false) }));
    expect(describeProgress(result)).toBe("1 of 2 steps and 1 of 3 milestones done.");
    expect(result.percent).toBe(40);
  });
});
