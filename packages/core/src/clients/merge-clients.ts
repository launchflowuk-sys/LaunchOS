import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { applyMove, countMove, MOVE_SPECS, type MoveCounts } from "./merge-clients-tables.js";

/**
 * Two client records for one business — a Stripe import that made "Safiullah
 * Mansoor" next to the "Grays Town Taxis" Shoji typed in by hand — become
 * one. Everything that points at the duplicate is re-pointed at the kept
 * client in a single transaction, the duplicate is archived with
 * `metadata.mergedInto`, and both sides are audited.
 */

type ClientRow = typeof schema.clients.$inferSelect;

const MergePair = z.object({
  keepId: z.string().uuid(),
  mergeId: z.string().uuid(),
});

export const MergeClientsInput = MergePair.extend({
  actorKind: z.enum(["user", "system"]).default("user"),
  actorId: z.string().optional(),
});
export type MergeClientsInput = z.input<typeof MergeClientsInput>;
export const MergePreviewInput = MergePair;
export type MergePreviewInput = z.input<typeof MergePreviewInput>;

export type MergeCounts = Record<string, number>;

export interface MergeClientsResult {
  kept: ClientRow;
  merged: ClientRow;
  /** Rows re-pointed at the kept client, by table. */
  moved: MergeCounts;
  /** Rows left on the archived client because the kept one already had their equivalent. */
  left: MergeCounts;
  /** Duplicate rows deleted (a portal user on both, the duplicate's support address). */
  dropped: MergeCounts;
}

export interface MergePreview {
  keep: Pick<ClientRow, "id" | "name" | "status" | "email" | "packageId" | "supportEmail">;
  merge: Pick<ClientRow, "id" | "name" | "status" | "email" | "packageId" | "supportEmail">;
  moved: MergeCounts;
  left: MergeCounts;
  dropped: MergeCounts;
  /** Plain-English consequences worth a line on the confirm screen. */
  warnings: string[];
}

export class MergeRefused extends Error {
  constructor(readonly reason: "same_client" | "not_found" | "keep_archived", message: string) {
    super(message);
    this.name = "MergeRefused";
  }
}

async function loadPair(db: Db, organisationId: string, keepId: string, mergeId: string): Promise<{ keep: ClientRow; merge: ClientRow }> {
  if (keepId === mergeId) throw new MergeRefused("same_client", "A client cannot be merged into itself.");
  const find = async (id: string) => {
    const [row] = await db.select().from(schema.clients)
      .where(and(eq(schema.clients.id, id), eq(schema.clients.organisationId, organisationId)));
    if (!row || row.deletedAt) throw new MergeRefused("not_found", `client ${id} not found in organisation`);
    return row;
  };
  const [keep, merge] = await Promise.all([find(keepId), find(mergeId)]);
  if (keep.status === "archived") throw new MergeRefused("keep_archived", `${keep.name} is archived; merge into a live client.`);
  return { keep, merge };
}

type BillingProfileRow = typeof schema.billingProfiles.$inferSelect;

async function billingProfileOf(db: Db, organisationId: string, clientId: string): Promise<BillingProfileRow | undefined> {
  const [row] = await db.select().from(schema.billingProfiles)
    .where(and(eq(schema.billingProfiles.organisationId, organisationId), eq(schema.billingProfiles.clientId, clientId)));
  return row;
}

interface Pair {
  organisationId: string;
  keepId: string;
  mergeId: string;
}

/**
 * The duplicate's billing profile: moved across when the kept client has
 * none; otherwise its Stripe customer becomes a payment account of the kept
 * client (its primary too, when the kept profile names no customer of its
 * own) and the duplicate profile is dropped. Returns what happened, in the
 * same shape as a table move.
 */
async function mergeBillingProfiles(db: Db, pair: Pair, write: boolean): Promise<MoveCounts & { warning?: string }> {
  const [keptProfile, mergedProfile] = await Promise.all([
    billingProfileOf(db, pair.organisationId, pair.keepId), billingProfileOf(db, pair.organisationId, pair.mergeId),
  ]);
  if (!mergedProfile) return { moved: 0, left: 0, dropped: 0 };
  if (!keptProfile) {
    if (write) {
      await db.update(schema.billingProfiles).set({ clientId: pair.keepId, updatedAt: new Date() })
        .where(eq(schema.billingProfiles.id, mergedProfile.id));
    }
    return { moved: 1, left: 0, dropped: 0 };
  }
  const customerId = mergedProfile.stripeCustomerId;
  const warning = customerId
    ? (keptProfile.stripeCustomerId
      ? `Both clients have a Stripe customer; ${customerId} becomes an extra payment account of the kept client.`
      : `Stripe customer ${customerId} moves to the kept client's billing profile.`)
    : undefined;
  if (write) {
    await db.delete(schema.billingProfiles).where(eq(schema.billingProfiles.id, mergedProfile.id));
    if (customerId) {
      if (!keptProfile.stripeCustomerId) {
        await db.update(schema.billingProfiles).set({ stripeCustomerId: customerId, updatedAt: new Date() })
          .where(eq(schema.billingProfiles.id, keptProfile.id));
      }
      // The account row normally exists already (the backfill, or the sync);
      // this covers a profile linked by hand. The generic move then brings it
      // across with the rest of the duplicate's accounts.
      await db.insert(schema.clientPaymentAccounts).values({
        organisationId: pair.organisationId, clientId: pair.mergeId, provider: "stripe", externalCustomerId: customerId,
        name: mergedProfile.billingName, isPrimary: false,
      }).onConflictDoNothing({ target: [schema.clientPaymentAccounts.provider, schema.clientPaymentAccounts.externalCustomerId] });
    }
  }
  return { moved: 0, left: 0, dropped: 1, ...(warning ? { warning } : {}) };
}

/**
 * After the move, the kept client's primary account is the one its billing
 * profile names — or, when the profile names none, its oldest account — and
 * nothing else is primary.
 */
async function normalisePrimaryAccount(db: Db, pair: Pair): Promise<void> {
  const [profile, accounts] = await Promise.all([
    billingProfileOf(db, pair.organisationId, pair.keepId),
    db.select().from(schema.clientPaymentAccounts)
      .where(and(eq(schema.clientPaymentAccounts.organisationId, pair.organisationId), eq(schema.clientPaymentAccounts.clientId, pair.keepId)))
      .orderBy(asc(schema.clientPaymentAccounts.createdAt)),
  ]);
  if (accounts.length === 0) return;
  const primaryId = accounts.find((a) => a.externalCustomerId === profile?.stripeCustomerId)?.id ?? accounts[0]!.id;
  for (const account of accounts) {
    const shouldBe = account.id === primaryId;
    if (account.isPrimary === shouldBe) continue;
    await db.update(schema.clientPaymentAccounts).set({ isPrimary: shouldBe, updatedAt: new Date() })
      .where(eq(schema.clientPaymentAccounts.id, account.id));
  }
}

function summarise(keep: ClientRow, merge: ClientRow, counts: Record<string, MoveCounts>, billingWarning?: string): MergePreview {
  const pick = (c: ClientRow) => ({ id: c.id, name: c.name, status: c.status, email: c.email, packageId: c.packageId, supportEmail: c.supportEmail });
  const by = (field: keyof MoveCounts) =>
    Object.fromEntries(Object.entries(counts).filter(([, c]) => c[field] > 0).map(([key, c]) => [key, c[field]]));
  const warnings = [
    ...(billingWarning ? [billingWarning] : []),
    ...(counts["email_identities"]?.dropped ? [`Support address ${merge.supportEmail ?? "of the merged client"} is retired; mail to it will no longer route.`] : []),
    ...(counts["client_users"]?.dropped ? [`${counts["client_users"].dropped} portal login(s) already on the kept client are dropped from the duplicate.`] : []),
    ...Object.entries(counts).filter(([, c]) => c.left > 0).map(([key, c]) => `${c.left} ${key.replace(/_/g, " ")} stay on the archived client (the kept one already has the same).`),
    ...(!keep.packageId && merge.packageId ? ["The kept client takes the merged client's package."] : []),
  ];
  return { keep: pick(keep), merge: pick(merge), moved: by("moved"), left: by("left"), dropped: by("dropped"), warnings };
}

/** What `mergeClients` would do, for the confirm screen. Nothing is written. */
export async function mergePreview(db: Db, organisationId: string, input: MergePreviewInput): Promise<MergePreview> {
  const v = MergePreviewInput.parse(input);
  const { keep, merge } = await loadPair(db, organisationId, v.keepId, v.mergeId);
  const pair: Pair = { organisationId, keepId: keep.id, mergeId: merge.id };
  const counts: Record<string, MoveCounts> = {};
  const billing = await mergeBillingProfiles(db, pair, false);
  counts["billing_profiles"] = billing;
  for (const spec of MOVE_SPECS) counts[spec.key] = await countMove(db, spec, pair);
  return summarise(keep, merge, counts, billing.warning);
}

/** The kept client's fields, filled from the duplicate only where the kept one is empty. */
function fillFrom(keep: ClientRow, merge: ClientRow): Partial<ClientRow> {
  const fillable = ["tradingName", "email", "phone", "addressLine1", "addressLine2", "city", "postcode", "websiteUrl", "industry", "packageId"] as const;
  const patch: Partial<ClientRow> = {};
  for (const field of fillable) {
    if (keep[field] === null && merge[field] !== null) (patch as Record<string, unknown>)[field] = merge[field];
  }
  if (merge.notes?.trim()) {
    const stamp = new Date().toISOString().slice(0, 10);
    const heading = `--- Merged from "${merge.name}" on ${stamp} ---`;
    patch.notes = [keep.notes?.trim(), heading, merge.notes.trim()].filter((part): part is string => !!part).join("\n\n");
  }
  return patch;
}

/**
 * Merges `mergeId` into `keepId`: every row that points at the duplicate is
 * re-pointed (see `MOVE_SPECS` for the per-table rules), the kept client's
 * empty fields and notes are filled from the duplicate, the duplicate is
 * archived with `metadata.mergedInto`, `client.merged` is audited on both
 * and the kept timeline gets an entry. All or nothing.
 */
export async function mergeClients(db: Db, organisationId: string, input: MergeClientsInput): Promise<MergeClientsResult> {
  const v = MergeClientsInput.parse(input);
  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const { keep, merge } = await loadPair(tx, organisationId, v.keepId, v.mergeId);
    const pair: Pair = { organisationId, keepId: keep.id, mergeId: merge.id };
    const counts: Record<string, MoveCounts> = {};
    counts["billing_profiles"] = await mergeBillingProfiles(tx, pair, true);
    for (const spec of MOVE_SPECS) counts[spec.key] = await applyMove(tx, spec, pair);
    await normalisePrimaryAccount(tx, pair);

    const now = new Date();
    const [kept] = await tx.update(schema.clients).set({ ...fillFrom(keep, merge), updatedAt: now })
      .where(eq(schema.clients.id, keep.id)).returning();
    const [merged] = await tx.update(schema.clients).set({
      status: "archived", updatedAt: now,
      metadata: { ...merge.metadata, mergedInto: keep.id, mergedAt: now.toISOString() },
    }).where(eq(schema.clients.id, merge.id)).returning();

    const summary = summarise(kept!, merged!, counts);
    const actor = { actorKind: v.actorKind, actorId: v.actorId };
    await recordAudit(tx, organisationId, {
      ...actor, action: "client.merged", targetType: "client", targetId: keep.id, before: keep,
      after: { ...kept, mergedFrom: merge.id, moved: summary.moved, left: summary.left, dropped: summary.dropped },
    });
    await recordAudit(tx, organisationId, {
      ...actor, action: "client.merged", targetType: "client", targetId: merge.id, before: merge, after: merged,
    });
    const movedTotal = Object.values(summary.moved).reduce((sum, n) => sum + n, 0);
    await recordActivity(tx, organisationId, {
      ...actor, clientId: keep.id, kind: "client.merged",
      title: `Merged "${merge.name}" into this client`,
      body: `${movedTotal} record${movedTotal === 1 ? "" : "s"} moved across${
        Object.keys(summary.moved).length > 0 ? ` (${Object.entries(summary.moved).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(", ")})` : ""
      }. The duplicate is archived.`,
      link: `/clients/${keep.id}`,
    });
    return { kept: kept!, merged: merged!, moved: summary.moved, left: summary.left, dropped: summary.dropped };
  });
}
