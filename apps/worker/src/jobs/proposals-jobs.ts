import { PROPOSAL_DRAFTER_KEY } from "@launchos/agents";
import {
  expireProposals,
  nudgeUnopenedProposals,
  setProposalFollowOn,
  type ProposalAcceptedJobData,
} from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PaymentsAdapter } from "@launchos/integrations";
import { QUEUE } from "../boss.js";
import type { EnablementLogger } from "./content-enablement.js";
import { LONDON, type BossRegistrar } from "./content-jobs.js";
import { handleProposalAccepted } from "./proposals-accepted.js";
import { PROPOSAL_SEND_SWEEP_CRON, handleProposalSend, runProposalSendSweep, type ProposalSendJob } from "./proposals-send.js";
import { sweepOrganisations, type SweepOrganisationsLogger } from "./sweep-organisations.js";

/**
 * The four proposal queues, their crons, and the hook that lets `core` hand
 * work to this process.
 *
 * Registered together rather than inline in `main()` so a test can boot them
 * against a fake boss and assert the schedule — the kind of table that is only
 * ever wrong in production.
 */

/**
 * When each cron queue wakes, in Europe/London.
 *
 * - `proposals.send` every two minutes: the delivery insurance under an
 *   approved card and an acceptance, both of which have somebody waiting.
 * - `proposals.expire` at 06:30, before Shoji reads anything, so a proposal
 *   that ran out overnight is already `expired` when the day starts and no
 *   client can accept a price that no longer stands.
 * - `proposals.nudge` at 09:00, with the rest of the morning's bells rather
 *   than at dawn — it is a prompt to chase somebody, and nobody chases at
 *   half past six.
 */
export const PROPOSAL_CRON = {
  [QUEUE.proposalsSend]: PROPOSAL_SEND_SWEEP_CRON,
  [QUEUE.proposalsExpire]: "30 6 * * *",
  [QUEUE.proposalsNudge]: "0 9 * * *",
} as const;

export interface ProposalJobsDeps {
  readonly db: Db;
  readonly boss: BossRegistrar;
  readonly payments: PaymentsAdapter;
  /** `APP_URL` and `STORAGE_DIR` — for the public links and where the PDFs are kept. */
  readonly env: NodeJS.ProcessEnv;
  readonly logger?: SweepOrganisationsLogger & Pick<Console, "info" | "warn" | "error">;
}

export interface ProposalSweepTotals {
  organisations: number;
  expired: number;
  nudged: number;
}

/** Live proposals past their validity date, moved to `expired` with the owner told. */
export async function runProposalExpiry(deps: Pick<ProposalJobsDeps, "db" | "logger">, now: Date): Promise<ProposalSweepTotals> {
  const logger = deps.logger ?? console;
  const totals: ProposalSweepTotals = { organisations: 0, expired: 0, nudged: 0 };
  await sweepOrganisations(deps.db, "proposal expiry", async (organisationId) => {
    const { expired } = await expireProposals(deps.db, organisationId, { now });
    totals.organisations += 1;
    totals.expired += expired.length;
    if (expired.length > 0) logger.info({ organisationId, expired: expired.map((p) => p.reference) }, "proposals expired");
  }, logger);
  return totals;
}

/**
 * Sent, unopened after three days — the owner's bell and nothing else.
 *
 * Deliberately not an email to the client. Shoji said chasing is his call to
 * make, so this sweep's whole job is to make sure he knows a proposal has gone
 * unread; what he does about it is his.
 */
export async function runProposalNudges(deps: Pick<ProposalJobsDeps, "db" | "logger">, now: Date): Promise<ProposalSweepTotals> {
  const logger = deps.logger ?? console;
  const totals: ProposalSweepTotals = { organisations: 0, expired: 0, nudged: 0 };
  await sweepOrganisations(deps.db, "proposal nudges", async (organisationId) => {
    const { nudged } = await nudgeUnopenedProposals(deps.db, organisationId, { now });
    totals.organisations += 1;
    totals.nudged += nudged.length;
    if (nudged.length > 0) logger.info({ organisationId, nudged: nudged.map((p) => p.reference) }, "proposals still unopened");
  }, logger);
  return totals;
}

/**
 * Switches the Proposal Drafter on, once, for every organisation that has
 * never decided about it — the same insert-only default the Content Writer,
 * the Ops Brief and the Lead Qualifier get at boot. A row that exists, on or
 * off, is never touched: Settings → Agents stays the authority. The drafter
 * only ever runs when a person asks it to, and nothing it writes reaches a
 * client without the `proposal_send` card, so "on unless switched off" is the
 * right default.
 */
export async function ensureProposalDrafterEnabled(db: Db, logger: EnablementLogger = console): Promise<{ enabled: number }> {
  const organisations = await db.select({ id: schema.organisations.id }).from(schema.organisations);
  if (organisations.length === 0) return { enabled: 0 };
  const inserted = await db
    .insert(schema.agentEnablement)
    .values(organisations.map((org) => ({ organisationId: org.id, agentKey: PROPOSAL_DRAFTER_KEY, enabled: true })))
    .onConflictDoNothing({ target: [schema.agentEnablement.organisationId, schema.agentEnablement.agentKey] })
    .returning({ organisationId: schema.agentEnablement.organisationId });
  if (inserted.length > 0) {
    logger.info({ agent: PROPOSAL_DRAFTER_KEY, organisations: inserted.map((r) => r.organisationId) }, "proposal drafter enabled by default");
  }
  return { enabled: inserted.length };
}

/**
 * Installs the hand-off `acceptProposal` calls after it commits.
 *
 * `core` may not import pg-boss, so the sender is module state with a no-op
 * default and this is the process that fills it in — exactly like `setEnqueue`
 * beside it in `main()`. Keyed per proposal onto the `short` queue, so the
 * acceptance and the sweep racing on the same proposal collapse into one job
 * while the first is still queued. Deliberately no `singletonSeconds`: the
 * window covers failed jobs too, and a follow-on that failed must be
 * re-queueable the same day.
 */
export function installProposalFollowOn(boss: Pick<BossRegistrar, "send">): void {
  setProposalFollowOn(async (job: ProposalAcceptedJobData) => {
    await boss.send(QUEUE.proposalsAccepted, job, { singletonKey: `proposal-accepted:${job.proposalId}` });
  });
}

/** Registers the four queues' workers and the three crons, Europe/London. */
export async function registerProposalJobs(deps: ProposalJobsDeps): Promise<void> {
  const { db, boss } = deps;
  const logger = deps.logger ?? console;

  installProposalFollowOn(boss);

  await boss.work<ProposalSendJob>(QUEUE.proposalsSend, async ([job]) => {
    const data = job!.data ?? {};
    // An empty payload is the cron's tick; anything else names one proposal or
    // one decided card.
    if (!data.organisationId) {
      logger.info(await runProposalSendSweep({ db, boss, logger }), "proposal send sweep");
      return;
    }
    logger.info(await handleProposalSend({ db, logger }, data), "proposal send");
  });

  await boss.work<ProposalAcceptedJobData>(QUEUE.proposalsAccepted, async ([job]) => {
    const result = await handleProposalAccepted({ db, payments: deps.payments, env: deps.env, logger }, job!.data);
    logger.info(result, "proposal follow-on");
  });

  await boss.work(QUEUE.proposalsExpire, async () => {
    logger.info(await runProposalExpiry({ db, logger }, new Date()), "proposal expiry sweep");
  });

  await boss.work(QUEUE.proposalsNudge, async () => {
    logger.info(await runProposalNudges({ db, logger }, new Date()), "proposal nudge sweep");
  });

  for (const [queue, cron] of Object.entries(PROPOSAL_CRON)) {
    await boss.schedule(queue, cron, {}, { tz: LONDON });
  }
}
