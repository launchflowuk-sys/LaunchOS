import { ContentRefused, periodKeyFor, planContentMonth } from "@launchos/core";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { PackageIncludes } from "@launchos/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { QUEUE, dailyDedupe } from "../boss.js";
import type { ContentDraftJob } from "./content-draft.js";
import type { BossSender } from "./dispatch-event.js";
import { sweep, throwOnSweepFailure, type SweepLogger } from "./sweep.js";

/** The subscription statuses that are still paying for a package: the same three `activeSubscriptionForClient` reads. */
const SUBSCRIBED = ["trialing", "active", "past_due"] as const;

export interface PlanMonthLogger extends SweepLogger {
  info(...args: unknown[]): void;
}

export interface PlanMonthDeps {
  readonly db: Db;
  readonly boss: BossSender;
  readonly logger?: PlanMonthLogger;
}

export interface PlanMonthResult {
  periodKey: string;
  /** Clients with a live subscription whose package has at least one content quota. */
  clients: number;
  /** Slots created this run, across every client. */
  created: number;
  /** Clients with an unfilled slot this month, so a `content.draft` was sent. */
  drafts: number;
  /** Clients the planner refused (no subscription, no package) — expected, not failures. */
  skipped: number;
  failed: number;
}

/** The key the fan-out and the UI both use, so a manual run can add its own suffix. */
export function contentDraftKey(clientId: string, periodKey: string): string {
  return `content-draft:${clientId}:${periodKey}`;
}

function hasContentQuota(includes: PackageIncludes): boolean {
  return includes.socialPostsPerMonth > 0 || includes.blogPostsPerMonth > 0 || includes.gbpUpdatesPerMonth > 0;
}

/**
 * Every active client whose live subscription's package owes them content
 * this month. Read from the subscription, not `clients.package_id`, for the
 * same reason `planContentMonth` does: what they are paying for is what they get.
 */
export async function clientsOwedContent(db: Db, organisationId: string): Promise<{ clientId: string }[]> {
  const rows = await db
    .select({ clientId: schema.subscriptions.clientId, includes: schema.packages.includes })
    .from(schema.subscriptions)
    .innerJoin(schema.packages, eq(schema.subscriptions.packageId, schema.packages.id))
    .innerJoin(schema.clients, eq(schema.subscriptions.clientId, schema.clients.id))
    .where(and(
      eq(schema.subscriptions.organisationId, organisationId),
      inArray(schema.subscriptions.status, [...SUBSCRIBED]),
      isNull(schema.subscriptions.deletedAt),
      eq(schema.clients.status, "active"),
      isNull(schema.clients.deletedAt),
    ));
  const seen = new Set<string>();
  return rows
    .filter((row) => hasContentQuota(row.includes))
    .filter((row) => (seen.has(row.clientId) ? false : (seen.add(row.clientId), true)))
    .map((row) => ({ clientId: row.clientId }));
}

/**
 * Lays out the current month for every client owed content and starts a
 * writer run for each month that still has an unfilled slot.
 *
 * Both halves are safe to repeat. `planContentMonth` is idempotent per slot,
 * and the draft is only sent when the month has a slot with no body, keyed
 * per client per month under a one-day window — so a retry of this job, or
 * a second tick, lays out nothing twice and starts no second Opus run for a
 * client already dispatched today. Each client has its own error boundary;
 * a client whose plan throws costs nobody else their month.
 */
export async function runPlanMonth(deps: PlanMonthDeps, organisationId: string, now: Date): Promise<PlanMonthResult> {
  const logger = deps.logger ?? console;
  const periodKey = periodKeyFor(now);
  const clients = await clientsOwedContent(deps.db, organisationId);

  let created = 0;
  let drafts = 0;
  let skipped = 0;
  const label = `content plan-month (${organisationId})`;
  const summary = await sweep(clients, { label, id: (c) => c.clientId, logger }, async ({ clientId }) => {
    let items;
    try {
      const planned = await planContentMonth(deps.db, organisationId, { clientId, periodKey, actorKind: "system" });
      created += planned.created;
      items = planned.items;
    } catch (error) {
      // No live subscription or no package between the read above and the
      // plan: the client is not owed content after all.
      if (error instanceof ContentRefused) { skipped += 1; return; }
      throw error;
    }
    const unfilled = items.some((item) => item.status === "draft" && !item.body?.trim());
    if (!unfilled) return;
    const job: ContentDraftJob = { organisationId, clientId, periodKey, trigger: "cron" };
    await deps.boss.send(QUEUE.contentDraft, job, dailyDedupe(contentDraftKey(clientId, periodKey)));
    drafts += 1;
  });

  const result: PlanMonthResult = { periodKey, clients: clients.length, created, drafts, skipped, failed: summary.failed };
  logger.info({ organisationId, ...result }, "content plan-month");
  throwOnSweepFailure(label, summary);
  return result;
}
