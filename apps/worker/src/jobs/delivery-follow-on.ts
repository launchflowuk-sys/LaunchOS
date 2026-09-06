import {
  ContentRefused, DeliveryRefused, countersignDeliveryReport, generateRecurringTasks, periodKeyFor,
  planContentMonth, requireProject, type ContentItemRow,
} from "@launchos/core";
import type { Db } from "@launchos/db";
import { QUEUE, dailyDedupe } from "../boss.js";
import type { ContentDraftJob } from "./content-draft.js";
import { contentDraftKey } from "./content-plan-month.js";
import type { BossSender } from "./dispatch-event.js";
import type { ProjectDeliveredJob } from "./case-study-launch.js";

/**
 * What a signature turns into.
 *
 * The client reads their handover report, signs it, and `signOffDelivery`
 * commits the signature and calls `deliverProject` — which emits
 * `project.delivered`. Everything below hangs off that event rather than off
 * the sign-off, and deliberately so: Shoji can also close a build by hand from
 * the admin page, and a care plan that only started when somebody clicked a
 * link on a public page would quietly never start for those.
 *
 * Three things happen here, none of which could sit inside the transaction
 * that recorded the signature:
 *
 * 1. **The countersigned copy.** The same report with the sign-off block on
 *    it, filed against `delivery_sign_offs.document_id`. It needs Chromium, so
 *    it needs this process.
 * 2. **The care plan's recurring tasks.** The retainer's monthly service work,
 *    created now rather than at 06:00 tomorrow.
 * 3. **The month's content quota.** The slots the package owes, laid out and —
 *    if the month still has an empty one — handed to the Content Writer under
 *    the same key the monthly planner uses, so the two cannot both pay for a
 *    run.
 *
 * Every step is idempotent, which is what makes the job safe to retry and safe
 * to receive twice: countersigning claims `document_id IS NULL`, recurring
 * tasks claim `(client_id, recurrence_key)`, and a content slot claims
 * `(channel, slot)` for the month.
 */

export interface DeliveryFollowOnDeps {
  readonly db: Db;
  readonly boss: BossSender;
  /** `STORAGE_DIR` for the countersigned PDF, `APP_URL` for the links printed on it. */
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Pick<Console, "info" | "warn" | "error">;
}

export interface DeliveryFollowOnResult {
  projectId: string;
  clientId: string;
  /** The countersigned document written this run; null when there is none to write. */
  countersignedDocumentId: string | null;
  /** Why nothing was countersigned, when nothing was. */
  countersignSkipped: "not_signed_off" | "already" | null;
  /** Recurring tasks created across the organisation by this run. */
  recurringTasksCreated: number;
  /** Content slots created for this client's current month. */
  contentSlotsCreated: number;
  /** Why the month was not planned, when it was not. */
  contentSkipped: ContentRefused["reason"] | null;
  /** True when the month had an empty slot and a writer run was queued. */
  writerQueued: boolean;
}

/**
 * Countersigns the handover and starts the care plan.
 *
 * The care plan is what the client was promised in the handover email — "signing
 * it off is what starts your care plan" — so a failure to countersign must not
 * cost them it, and a failure to plan content must not cost them their tasks.
 * Each step is therefore reported rather than allowed to abort the next; a real
 * fault still throws, so pg-boss retries and the idempotency above absorbs the
 * repeat.
 */
export async function handleDeliveryFollowOn(
  deps: DeliveryFollowOnDeps,
  job: ProjectDeliveredJob,
): Promise<DeliveryFollowOnResult> {
  const logger = deps.logger ?? console;
  const organisationId = job.organisationId;
  const project = await requireProject(deps.db, organisationId, job.projectId);

  const countersigned = await countersign(deps, organisationId, job.projectId, logger);
  const care = await startCarePlan(deps, organisationId, project.clientId, logger);

  return {
    projectId: project.id,
    clientId: project.clientId,
    ...countersigned,
    ...care,
  };
}

type CountersignOutcome = Pick<DeliveryFollowOnResult, "countersignedDocumentId" | "countersignSkipped">;

/**
 * The countersigned copy, once.
 *
 * `not_signable` is the expected answer for a project Shoji marked delivered
 * himself: there is no signature, so there is nothing to countersign. It is a
 * business answer, not a fault, and must not fail a job whose other half is
 * the client's care plan.
 */
async function countersign(
  deps: DeliveryFollowOnDeps,
  organisationId: string,
  projectId: string,
  logger: Pick<Console, "info" | "warn" | "error">,
): Promise<CountersignOutcome> {
  try {
    const document = await countersignDeliveryReport(deps.db, organisationId, { projectId }, undefined, deps.env ?? process.env);
    if (!document) return { countersignedDocumentId: null, countersignSkipped: "already" };
    return { countersignedDocumentId: document.id, countersignSkipped: null };
  } catch (error) {
    if (error instanceof DeliveryRefused && (error.reason === "not_signable" || error.reason === "not_found")) {
      logger.info({ organisationId, projectId, reason: error.reason }, "no client sign-off to countersign");
      return { countersignedDocumentId: null, countersignSkipped: "not_signed_off" };
    }
    throw error;
  }
}

type CareOutcome = Pick<DeliveryFollowOnResult, "recurringTasksCreated" | "contentSlotsCreated" | "contentSkipped" | "writerQueued">;

/**
 * The retainer, started today rather than tomorrow.
 *
 * `generateRecurringTasks` is the organisation-wide sweep the 06:00 cron
 * already runs, called whole rather than reimplemented for one client: it is
 * idempotent per `(client_id, recurrence_key)`, so every other client's tasks
 * for the period are skipped and the delivered client's are created now. That
 * order matters for the second half — `planContentMonth` links each slot to the
 * recurring task it belongs to, so the tasks have to exist first.
 */
async function startCarePlan(
  deps: DeliveryFollowOnDeps,
  organisationId: string,
  clientId: string,
  logger: Pick<Console, "info" | "warn" | "error">,
): Promise<CareOutcome> {
  const now = new Date();
  const tasks = await generateRecurringTasks(deps.db, organisationId, { now });

  const periodKey = periodKeyFor(now);
  let items: ContentItemRow[];
  let slotsCreated = 0;
  try {
    const planned = await planContentMonth(deps.db, organisationId, { clientId, periodKey, actorKind: "system" });
    items = planned.items;
    slotsCreated = planned.created;
  } catch (error) {
    // No live subscription yet, or a package with no content quota. A build
    // handed over on a one-off price is not owed posts, and that is not a fault.
    if (!(error instanceof ContentRefused)) throw error;
    logger.info({ organisationId, clientId, reason: error.reason }, "no content quota to start for this client");
    return { recurringTasksCreated: tasks.created, contentSlotsCreated: 0, contentSkipped: error.reason, writerQueued: false };
  }

  const unfilled = items.some((item) => item.status === "draft" && !item.body?.trim());
  if (!unfilled) {
    return { recurringTasksCreated: tasks.created, contentSlotsCreated: slotsCreated, contentSkipped: null, writerQueued: false };
  }
  // The same key and the same day-long window the monthly planner sends under,
  // so a delivery on the 1st and that morning's `content.plan-month` cannot
  // both pay for an Opus-priced writer run. A day is well inside the archive
  // interval `ARCHIVE_COMPLETED_AFTER_SECONDS` sets, which is what a
  // `singletonSeconds` window has to fit inside.
  const draft: ContentDraftJob = { organisationId, clientId, periodKey, trigger: "event" };
  await deps.boss.send(QUEUE.contentDraft, draft, dailyDedupe(contentDraftKey(clientId, periodKey)));
  return { recurringTasksCreated: tasks.created, contentSlotsCreated: slotsCreated, contentSkipped: null, writerQueued: true };
}
