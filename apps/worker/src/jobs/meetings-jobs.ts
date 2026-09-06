import { followUpMeetings, sendMeetingReminders } from "@launchos/core";
import type { Db } from "@launchos/db";
import { QUEUE } from "../boss.js";
import { LONDON, type BossRegistrar } from "./content-jobs.js";
import { sweepOrganisations, type SweepOrganisationsLogger } from "./sweep-organisations.js";

/**
 * Reminders every ten minutes — a 24-hour or one-hour reminder up to ten
 * minutes late is fine; the 15-minute host alert is what the interval is
 * sized for. Follow-ups once a morning, after the previous evening's calls
 * have had their two hours.
 */
export const MEETING_CRON = {
  [QUEUE.meetingsRemind]: "*/10 * * * *",
  [QUEUE.meetingsFollowUp]: "0 9 * * *",
} as const;

export interface MeetingJobsDeps {
  readonly db: Db;
  readonly boss: BossRegistrar;
  /** `APP_URL`, `SUPPORT_CONTACT_EMAIL`, `MAIL_FROM` — for the links and the sender in every notice. */
  readonly env: NodeJS.ProcessEnv;
  readonly logger?: SweepOrganisationsLogger & { info(...args: unknown[]): void };
}

export interface MeetingSweepTotals {
  organisations: number;
  reminded24h: number;
  reminded1h: number;
  hostAlerted: number;
}

/** One reminder pass over every organisation; per-tenant isolation via `sweepOrganisations`. */
export async function runMeetingReminders(deps: Pick<MeetingJobsDeps, "db" | "env" | "logger">, now: Date): Promise<MeetingSweepTotals> {
  const logger = deps.logger ?? console;
  const totals: MeetingSweepTotals = { organisations: 0, reminded24h: 0, reminded1h: 0, hostAlerted: 0 };
  await sweepOrganisations(deps.db, "meeting reminders", async (organisationId) => {
    const r = await sendMeetingReminders(deps.db, organisationId, { now }, deps.env);
    totals.organisations += 1;
    totals.reminded24h += r.reminded24h.length;
    totals.reminded1h += r.reminded1h.length;
    totals.hostAlerted += r.hostAlerted.length;
    if (r.reminded24h.length + r.reminded1h.length + r.hostAlerted.length > 0) logger.info({ organisationId, ...r }, "meeting reminders");
  }, logger);
  return totals;
}

export interface FollowUpTotals {
  organisations: number;
  outcomeNudged: number;
  noShowEmailed: number;
}

export async function runMeetingFollowUps(deps: Pick<MeetingJobsDeps, "db" | "env" | "logger">, now: Date): Promise<FollowUpTotals> {
  const logger = deps.logger ?? console;
  const totals: FollowUpTotals = { organisations: 0, outcomeNudged: 0, noShowEmailed: 0 };
  await sweepOrganisations(deps.db, "meeting follow-ups", async (organisationId) => {
    const r = await followUpMeetings(deps.db, organisationId, { now }, deps.env);
    totals.organisations += 1;
    totals.outcomeNudged += r.outcomeNudged.length;
    totals.noShowEmailed += r.noShowEmailed.length;
    if (r.outcomeNudged.length + r.noShowEmailed.length > 0) logger.info({ organisationId, ...r }, "meeting follow-ups");
  }, logger);
  return totals;
}

/** Registers the two meeting queues' workers and their crons, Europe/London. */
export async function registerMeetingJobs(deps: MeetingJobsDeps): Promise<void> {
  const logger = deps.logger ?? console;
  await deps.boss.work(QUEUE.meetingsRemind, async () => {
    logger.info(await runMeetingReminders(deps, new Date()), "meeting reminder sweep");
  });
  await deps.boss.work(QUEUE.meetingsFollowUp, async () => {
    logger.info(await runMeetingFollowUps(deps, new Date()), "meeting follow-up sweep");
  });
  for (const [queue, cron] of Object.entries(MEETING_CRON)) {
    await deps.boss.schedule(queue, cron, {}, { tz: LONDON });
  }
}
