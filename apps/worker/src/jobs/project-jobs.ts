import { PROJECT_REPORTER_CRON, PROJECT_REPORTER_KEY, CASE_STUDY_WRITER_KEY } from "@launchos/agents";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { QUEUE } from "../boss.js";
import type { EnablementLogger } from "./content-enablement.js";
import { LONDON, type BossRegistrar } from "./content-jobs.js";
import { handleProjectDelivered, type ProjectDeliveredJob } from "./case-study-launch.js";
import { handleDeliveryFollowOn } from "./delivery-follow-on.js";
import { handleDeliverySend, type DeliverySendJob } from "./delivery-send.js";
import { handleMilestoneEmail, type MilestoneEmailJob } from "./project-milestone-email.js";
import { dispatchWeeklyUpdates } from "./project-weekly-update.js";
import type { SweepOrganisationsLogger } from "./sweep-organisations.js";

/**
 * The four project queues, the one cron, and the two agents' defaults.
 *
 * Registered together rather than inline in `main()` so a test can boot them
 * against a fake boss and assert the schedule — the kind of table that is only
 * ever wrong in production.
 */

/**
 * Friday at four, Europe/London.
 *
 * The only cron here, and the only one either P4 agent has. The two event
 * queues below are driven by `dispatch-event.ts`, not by a clock: a milestone
 * email that waited for the next tick would arrive the day after the good
 * news, which is the one thing that note cannot do.
 */
export const PROJECT_CRON = {
  [QUEUE.projectsWeeklyUpdate]: PROJECT_REPORTER_CRON,
} as const;

export interface ProjectJobsDeps {
  readonly db: Db;
  readonly boss: BossRegistrar;
  /** `STORAGE_DIR` for the screenshots, `APP_URL` for the links on them. */
  readonly env: NodeJS.ProcessEnv;
  readonly logger?: SweepOrganisationsLogger & Pick<Console, "info" | "warn" | "error">;
}

/**
 * Switches the Project Reporter and the Case Study Writer on, once, for every
 * organisation that has never decided about either.
 *
 * The same insert-only default the Content Writer, the Ops Brief, the Lead
 * Qualifier and the Proposal Drafter get at boot: a row that exists, on or
 * off, is never touched, and Settings → Agents stays the authority.
 *
 * On by default is right for both because neither can reach a client on its
 * own. The reporter's whole output is a card in Shoji's approvals queue, and
 * the writer's is a draft plus a card. The cost of leaving them on is a
 * Friday's worth of drafts nobody has to approve; the cost of leaving them off
 * is a portfolio that goes stale and clients who hear nothing for a month.
 */
export async function ensureProjectAgentsEnabled(db: Db, logger: EnablementLogger = console): Promise<{ enabled: number }> {
  const organisations = await db.select({ id: schema.organisations.id }).from(schema.organisations);
  if (organisations.length === 0) return { enabled: 0 };
  const rows = organisations.flatMap((org) => [
    { organisationId: org.id, agentKey: PROJECT_REPORTER_KEY, enabled: true },
    { organisationId: org.id, agentKey: CASE_STUDY_WRITER_KEY, enabled: true },
  ]);
  const inserted = await db
    .insert(schema.agentEnablement)
    .values(rows)
    .onConflictDoNothing({ target: [schema.agentEnablement.organisationId, schema.agentEnablement.agentKey] })
    .returning({ organisationId: schema.agentEnablement.organisationId, agentKey: schema.agentEnablement.agentKey });
  if (inserted.length > 0) {
    logger.info({ enabled: inserted.map((row) => `${row.agentKey}:${row.organisationId}`) }, "project agents enabled by default");
  }
  return { enabled: inserted.length };
}

/** Registers the four queues' workers and the Friday cron, Europe/London. */
export async function registerProjectJobs(deps: ProjectJobsDeps): Promise<void> {
  const { db, boss } = deps;
  const logger = deps.logger ?? console;

  await boss.work(QUEUE.projectsWeeklyUpdate, async () => {
    logger.info(await dispatchWeeklyUpdates({ db, boss, logger }, new Date()), "project weekly update sweep");
  });

  // The handover, sent from the one process that can print one. Queued by the
  // admin page's Send button; see `delivery-send.ts` for why a refusal here is
  // a log line rather than a failed job.
  await boss.work<DeliverySendJob>(QUEUE.deliverySend, async ([job]) => {
    logger.info(await handleDeliverySend({ db, env: deps.env, logger }, job!.data), "delivery send");
  });

  await boss.work<MilestoneEmailJob>(QUEUE.projectsMilestoneEmail, async ([job]) => {
    logger.info(await handleMilestoneEmail({ db, logger }, job!.data), "milestone email");
  });

  // Two halves, in this order and in one job.
  //
  // The follow-on is what the client was promised — the countersigned copy of
  // what they signed, and the care plan starting — so it goes first; the
  // screenshots and the story are ours, take twenty seconds and reach somebody
  // else's server. Both halves are idempotent, so a retry after either fails
  // repeats neither.
  await boss.work<ProjectDeliveredJob>(QUEUE.projectsDelivered, async ([job]) => {
    logger.info(await handleDeliveryFollowOn({ db, boss, env: deps.env, logger }, job!.data), "delivery follow-on");
    logger.info(await handleProjectDelivered({ db, boss, env: deps.env, logger }, job!.data), "project delivered");
  });

  for (const [queue, cron] of Object.entries(PROJECT_CRON)) {
    await boss.schedule(queue, cron, {}, { tz: LONDON });
  }
}
