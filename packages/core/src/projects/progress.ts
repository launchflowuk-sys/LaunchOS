import type { ProjectPhaseStatus, ProjectStatus } from "@launchos/db/schema";

/**
 * How far through a build is, as one number a client will believe.
 *
 * This is the most-read figure in the portal and the easiest one to get
 * dishonestly wrong, so the rule is written down here rather than assembled in
 * a page component.
 *
 * **What counts.** Every phase that is going to happen, and every milestone,
 * is one unit of the same size. A unit is complete when the phase is `done` or
 * the milestone has a `reached_at`. Progress is complete units over total
 * units. Nothing else is an input — in particular not the calendar, which is
 * the tempting one: "we are three weeks into a four-week job, so 75%" is a
 * number about our diary, not about their website, and it is 75% on the day
 * nothing has been built.
 *
 * **Why one pool rather than half phases and half milestones.** A fixed
 * 50/50 split makes the single milestone on a six-phase project worth as much
 * as the entire spine, so reaching it jumps the bar to 50% while the client
 * has seen nothing. Pooling makes each promise worth what it is worth: one of
 * seven things, not half the project. Where there are no milestones the pool
 * is the phases, and where a project is run entirely on milestones the pool is
 * the milestones — both fall out of the same arithmetic with no special case.
 *
 * **A skipped phase is in neither total.** A client who brought their own
 * design has no design phase; counting it done would be a lie and counting it
 * outstanding would hold their bar down for ever. It is removed from the
 * question, which is what "skipped" means.
 *
 * **An active phase earns nothing.** Half credit for work in progress is a
 * guess about how far through it is, and a guess dressed as a measurement is
 * the same dishonesty as counting days. We know a phase is finished; we do not
 * know that it is halfway. Milestones are how a long phase shows movement, and
 * a phase with no milestones under it is a phase that needs one.
 *
 * **Never 100% before delivery, and always 100% after it.** Delivery is a
 * human sign-off, not an arithmetic outcome: while `delivered_at` is unset the
 * result is capped at 99 however many boxes are ticked, because "100%" on a
 * page whose owner has not yet said the work is done reads as "finished" and
 * it is not. Once Shoji has signed it off the answer is 100 even with a care
 * milestone still open — a client told their site is live should not then be
 * shown 97%, and the outstanding item belongs on the timeline, not in the bar.
 *
 * **Nothing planned is 0%, not 100%.** An empty project has no complete units
 * and no total, and the vacuous "everything I know about is done" answer is
 * the single worst number this function could return. It is 0 until there is
 * something to measure.
 */

/** Only the fields the rule reads — so a test can state a case in one line. */
export interface ProgressPhase {
  status: ProjectPhaseStatus;
}

export interface ProgressMilestone {
  reachedAt: Date | null;
}

export interface ProjectProgressInput {
  status: ProjectStatus;
  deliveredAt: Date | null;
  phases: readonly ProgressPhase[];
  milestones: readonly ProgressMilestone[];
}

export interface ProjectProgress {
  /** 0–100, whole. The only number a page should print. */
  percent: number;
  phasesDone: number;
  /** Phases that count: everything except `skipped`. */
  phasesCounted: number;
  milestonesReached: number;
  milestonesTotal: number;
  unitsDone: number;
  unitsTotal: number;
  /** True once the work has been signed off, which is what pins the number to 100. */
  delivered: boolean;
}

/** The most a project that has not been handed over may show. */
export const MAX_UNDELIVERED_PERCENT = 99;

/** A phase that is neither done nor going to happen is still owed. */
function counts(phase: ProgressPhase): boolean {
  return phase.status !== "skipped";
}

export function projectProgress(input: ProjectProgressInput): ProjectProgress {
  const counted = input.phases.filter(counts);
  const phasesDone = counted.filter((phase) => phase.status === "done").length;
  const milestonesReached = input.milestones.filter((milestone) => milestone.reachedAt !== null).length;

  const unitsDone = phasesDone + milestonesReached;
  const unitsTotal = counted.length + input.milestones.length;
  const delivered = input.deliveredAt !== null || input.status === "delivered";

  const measured = unitsTotal === 0 ? 0 : Math.floor((unitsDone / unitsTotal) * 100);
  const percent = delivered ? 100 : Math.min(measured, MAX_UNDELIVERED_PERCENT);

  return {
    percent,
    phasesDone,
    phasesCounted: counted.length,
    milestonesReached,
    milestonesTotal: input.milestones.length,
    unitsDone,
    unitsTotal,
    delivered,
  };
}

/**
 * The sentence under the bar: "3 of 6 steps and 4 of 9 milestones done".
 *
 * The breakdown is shown next to the percentage on purpose. A number on its
 * own invites the question "out of what?", and the honest answer is the whole
 * defence of the number.
 */
export function describeProgress(progress: ProjectProgress): string {
  if (progress.delivered) return "Delivered.";
  if (progress.unitsTotal === 0) return "Not planned out yet.";
  const parts: string[] = [];
  if (progress.phasesCounted > 0) parts.push(`${progress.phasesDone} of ${progress.phasesCounted} steps`);
  if (progress.milestonesTotal > 0) parts.push(`${progress.milestonesReached} of ${progress.milestonesTotal} milestones`);
  return `${parts.join(" and ")} done.`;
}
