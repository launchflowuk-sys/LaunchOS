import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ContentChannel, PackageIncludes } from "@launchos/db/schema";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { activeSubscriptionForClient } from "../billing/subscriptions.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";
import { spreadSlotTimes } from "./schedule.js";
import {
  ActorKindSchema, ContentRefused, KIND_FOR_CHANNEL, PeriodKeySchema, TASK_KIND_FOR_CHANNEL, isUniqueViolation,
  type ContentItemRow,
} from "./shared.js";

export const PlanContentMonthInput = z.object({
  clientId: z.string().uuid(),
  periodKey: PeriodKeySchema,
  actorKind: ActorKindSchema.default("system"),
  actorId: z.string().min(1).optional(),
});
export type PlanContentMonthInput = z.input<typeof PlanContentMonthInput>;

export interface PlanContentMonthResult {
  created: number;
  skipped: number;
  /** Every slot the month now has, created or pre-existing, in publish order. */
  items: ContentItemRow[];
}

/** One planned slot before it is written: its channel, its per-channel index and when it goes out. */
interface Slot {
  channel: ContentChannel;
  slot: number;
  sequence: number;
  scheduledFor: Date;
}

/**
 * The month's slots from the package quotas. Social posts alternate Facebook
 * and Instagram in publish order; each channel numbers its own slots from 1
 * so the idempotency key is `(channel, slot)`, while `sequence` keeps the
 * position the recurring task was numbered by.
 */
export function slotsFor(periodKey: string, includes: PackageIncludes): Slot[] {
  const social = spreadSlotTimes(periodKey, includes.socialPostsPerMonth).map((scheduledFor, i): Slot => ({
    channel: i % 2 === 0 ? "facebook" : "instagram",
    slot: Math.floor(i / 2) + 1,
    sequence: i + 1,
    scheduledFor,
  }));
  const blog = spreadSlotTimes(periodKey, includes.blogPostsPerMonth).map((scheduledFor, i): Slot => ({
    channel: "blog", slot: i + 1, sequence: i + 1, scheduledFor,
  }));
  const gbp = spreadSlotTimes(periodKey, includes.gbpUpdatesPerMonth).map((scheduledFor, i): Slot => ({
    channel: "gbp", slot: i + 1, sequence: i + 1, scheduledFor,
  }));
  return [...social, ...blog, ...gbp];
}

/**
 * The month's recurring tasks for this client, keyed by `<kind>:<n>` —
 * `generateRecurringTasks` names them `social:2026-09:3`. The `*` entry per
 * kind is the lowest-numbered task, the fallback when the quota and the task
 * count disagree (a package changed mid-month).
 */
async function recurringTasksFor(db: Db, organisationId: string, clientId: string, periodKey: string): Promise<Map<string, string>> {
  const rows = await db.select({ id: schema.tasks.id, key: schema.tasks.recurrenceKey })
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.organisationId, organisationId),
      eq(schema.tasks.clientId, clientId),
      like(schema.tasks.recurrenceKey, `%:${periodKey}:%`),
      isNull(schema.tasks.deletedAt),
    ));
  const map = new Map<string, string>();
  const lowest = new Map<string, number>();
  for (const row of rows) {
    const [kind, , n] = row.key!.split(":");
    if (!kind || !n) continue;
    map.set(`${kind}:${n}`, row.id);
    if (Number(n) < (lowest.get(kind) ?? Infinity)) {
      lowest.set(kind, Number(n));
      map.set(`${kind}:*`, row.id);
    }
  }
  return map;
}

/**
 * Lays out a client's month: one empty draft per post the package includes,
 * each with a publish moment on a weekday at 10:00 London, spread evenly.
 *
 * Idempotent per (client, month, channel, slot): the pre-check skips slots
 * that exist and the partial unique index `content_items_planned_slot` turns
 * a genuine race into a skip rather than a duplicate. A slot that was
 * cancelled stays cancelled — it still occupies its key — so re-planning
 * never resurrects a post somebody took out.
 *
 * Quotas come from the client's *active subscription's* package, not the
 * client's `package_id`: what they are paying for this month is what they
 * get. No active subscription or a subscription with no package is a refusal
 * the caller can show; a package with zero quotas simply plans nothing.
 */
export async function planContentMonth(db: Db, organisationId: string, input: PlanContentMonthInput): Promise<PlanContentMonthResult> {
  const v = PlanContentMonthInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);

  const subscription = await activeSubscriptionForClient(db, organisationId, v.clientId);
  if (!subscription) throw new ContentRefused("no_active_subscription", "The client has no active subscription to plan content from.");
  if (!subscription.packageId) throw new ContentRefused("no_package", "The client's subscription has no package, so there are no content quotas.");
  const [pkg] = await db.select({ includes: schema.packages.includes }).from(schema.packages).where(and(
    eq(schema.packages.id, subscription.packageId),
    eq(schema.packages.organisationId, organisationId),
  ));
  if (!pkg) throw new ContentRefused("no_package", "The client's package could not be found.");

  const slots = slotsFor(v.periodKey, pkg.includes);
  const tasks = await recurringTasksFor(db, organisationId, v.clientId, v.periodKey);

  let created = 0;
  let skipped = 0;
  const items: ContentItemRow[] = [];

  for (const slot of slots) {
    const existing = await findSlot(db, organisationId, v.clientId, v.periodKey, slot.channel, slot.slot);
    if (existing) { skipped += 1; items.push(existing); continue; }

    const taskKind = TASK_KIND_FOR_CHANNEL[slot.channel];
    const taskId = tasks.get(`${taskKind}:${slot.sequence}`) ?? tasks.get(`${taskKind}:*`) ?? null;

    try {
      const row = await db.transaction(async (txRaw) => {
        const tx = txRaw as unknown as Db;
        const [inserted] = await tx.insert(schema.contentItems).values({
          organisationId,
          clientId: v.clientId,
          channel: slot.channel,
          kind: KIND_FOR_CHANNEL[slot.channel],
          status: "draft",
          periodKey: v.periodKey,
          scheduledFor: slot.scheduledFor,
          source: "agent",
          taskId,
          metadata: { slot: slot.slot, sequence: slot.sequence, plannedFromSubscriptionId: subscription.id },
        }).returning();
        await recordAudit(tx, organisationId, {
          actorKind: v.actorKind, actorId: v.actorId, action: "content_item.planned",
          targetType: "content_item", targetId: inserted!.id, after: inserted,
        });
        return inserted!;
      });
      created += 1;
      items.push(row);
    } catch (error) {
      if (!isUniqueViolation(error, "content_items_planned_slot")) throw error;
      // A concurrent plan already claimed this slot — a successful outcome too.
      skipped += 1;
      const raced = await findSlot(db, organisationId, v.clientId, v.periodKey, slot.channel, slot.slot);
      if (raced) items.push(raced);
    }
  }

  items.sort((a, b) => (a.scheduledFor?.getTime() ?? 0) - (b.scheduledFor?.getTime() ?? 0));
  return { created, skipped, items };
}

async function findSlot(
  db: Db,
  organisationId: string,
  clientId: string,
  periodKey: string,
  channel: ContentChannel,
  slot: number,
): Promise<ContentItemRow | undefined> {
  const [row] = await db.select().from(schema.contentItems).where(and(
    eq(schema.contentItems.organisationId, organisationId),
    eq(schema.contentItems.clientId, clientId),
    eq(schema.contentItems.periodKey, periodKey),
    eq(schema.contentItems.channel, channel),
    // The index key: the slot number as jsonb text.
    sql`${schema.contentItems.metadata} ->> 'slot' = ${String(slot)}`,
  ));
  return row;
}
