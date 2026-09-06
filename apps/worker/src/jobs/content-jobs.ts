import type { CmsProviderFactory } from "@launchos/agents";
import type { Db } from "@launchos/db";
import type { CmsProvider, ImageGenAdapter, SocialPublisher } from "@launchos/integrations";
import type PgBoss from "pg-boss";
import { QUEUE } from "../boss.js";
import type { AgentRunDeps } from "./agent-run.js";
import { handleContentDraft, type ContentDraftJob } from "./content-draft.js";
import { runPlanMonth } from "./content-plan-month.js";
import { backfillDueImages, handleContentRenderImage, type ContentRenderImageJob } from "./content-render-image.js";
import { runPublishDue } from "./content-publish-due.js";
import { runContentReports } from "./content-report.js";
import { sweepOrganisations } from "./sweep-organisations.js";

/** The slice of pg-boss the content jobs register against — narrow enough to fake. */
export type BossRegistrar = Pick<PgBoss, "work" | "schedule" | "send">;

export const LONDON = "Europe/London";

/**
 * When each cron queue wakes, in Europe/London. Exported so the boot test can
 * assert the schedule the worker actually registers.
 *
 * - plan-month on the 1st at 06:00, the same minute the recurring task sweep
 *   creates the month's social/content/gbp tasks the slots link to.
 * - publish-due every five minutes; `claimDueContent` takes `scheduled_for <=
 *   now`, so a 10:00 post goes out by 10:05.
 * - report on the 1st at 07:00, after plan-month and before the 07:45 client
 *   report, so last month's content is counted before anyone reads about it.
 */
export const CONTENT_CRON = {
  [QUEUE.contentPlanMonth]: "0 6 1 * *",
  [QUEUE.contentPublishDue]: "*/5 * * * *",
  [QUEUE.contentReport]: "0 7 1 * *",
} as const;

export interface ContentJobsDeps {
  readonly db: Db;
  readonly boss: BossRegistrar;
  readonly agentRun: AgentRunDeps;
  readonly social: SocialPublisher;
  readonly cms: CmsProvider | CmsProviderFactory;
  /** Draws post images: the branded template always, the generator when a client has asked and paid for one. */
  readonly imagegen: ImageGenAdapter;
  readonly logger?: Console;
}

/**
 * Registers the five content queues' workers and the three crons. Lives here
 * rather than inline in `main()` so a test can boot it against a fake boss
 * and assert what was registered — the schedule table above is the kind of
 * thing that is only ever wrong in production.
 *
 * `content.render-image` has no cron on purpose: it is sent by the post editor
 * and the approval card, and the one unattended render — the backfill below —
 * runs inside `content.publish-due` rather than on a clock of its own.
 */
export async function registerContentJobs(deps: ContentJobsDeps): Promise<void> {
  const { db, boss } = deps;
  const logger = deps.logger ?? console;

  await boss.work(QUEUE.contentPlanMonth, async () => {
    const now = new Date();
    await sweepOrganisations(db, "content plan-month", (organisationId) => runPlanMonth({ db, boss, logger }, organisationId, now), logger);
  });

  await boss.work<ContentDraftJob>(QUEUE.contentDraft, async ([job]) => {
    const result = await handleContentDraft(deps.agentRun, job!.data);
    logger.info({ clientId: job!.data.clientId, periodKey: job!.data.periodKey, result }, "content draft");
  });

  await boss.work<ContentRenderImageJob>(QUEUE.contentRenderImage, async ([job]) => {
    await handleContentRenderImage({ db, imagegen: deps.imagegen, logger }, job!.data);
  });

  await boss.work(QUEUE.contentPublishDue, async () => {
    const now = new Date();
    await sweepOrganisations(
      db,
      "content publish-due",
      async (organisationId) => {
        // Before the claim, never after: `claimDueContent` flips the item to
        // `publishing`, and a `publishing` item is refused a render. Template
        // mode only — see `backfillDueImages`.
        await backfillDueImages({ db, imagegen: deps.imagegen, logger }, organisationId, now);
        return runPublishDue({ db, social: deps.social, cms: deps.cms, logger }, organisationId, { now });
      },
      logger,
    );
  });

  await boss.work(QUEUE.contentReport, async () => {
    const now = new Date();
    await sweepOrganisations(db, "content reports", (organisationId) => runContentReports(db, organisationId, { now, logger }), logger);
  });

  for (const [queue, cron] of Object.entries(CONTENT_CRON)) {
    await boss.schedule(queue, cron, {}, { tz: LONDON });
  }
}
