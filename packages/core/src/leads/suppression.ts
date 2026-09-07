import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { normalisePhone } from "./phone.js";

/** Shorter than any real number, including the shortest national ones. */
const MIN_PHONE_DIGITS = 7;

export interface SuppressionRow {
  id: string;
  phone: string;
  note: string | null;
  addedByUserId: string | null;
  createdAt: Date;
}

export const AddSuppressionInput = z.object({
  /** Any way a number gets written; stored in one shape. */
  phone: z.string().trim().min(3, "that is not a number").max(40),
  note: z.string().trim().max(200).optional(),
  actorId: z.string().min(1).optional(),
});
export type AddSuppressionInput = z.input<typeof AddSuppressionInput>;

/** Raised for anything the screen should say out loud rather than swallow. */
export class SuppressionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SuppressionRefused";
  }
}

/**
 * Adds a number the inbound channels must never turn into a lead.
 *
 * Adding one twice is not an error — somebody protecting a family member from
 * a sales agent should not be told off for being careful — so a repeat returns
 * the row that is already there and leaves its note alone.
 */
export async function addSuppression(
  db: Db,
  organisationId: string,
  input: AddSuppressionInput,
): Promise<{ row: SuppressionRow; alreadyThere: boolean }> {
  const v = AddSuppressionInput.parse(input);
  const phone = normalisePhone(v.phone);
  // normalisePhone deliberately hands back anything it does not recognise, so
  // an unusual number is still storable. That is the wrong answer here: a list
  // that silently accepts "n/a" gives somebody the impression they are
  // protected when they are not.
  const digits = phone.replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS) {
    throw new SuppressionRefused("That does not look like a phone number.");
  }

  const [existing] = await db.select().from(schema.leadSuppressions).where(and(
    eq(schema.leadSuppressions.organisationId, organisationId),
    eq(schema.leadSuppressions.phone, phone),
  ));
  if (existing) return { row: existing, alreadyThere: true };

  const [row] = await db.insert(schema.leadSuppressions)
    .values({ organisationId, phone, note: v.note ?? null, addedByUserId: v.actorId ?? null })
    .onConflictDoNothing()
    .returning();

  // Lost a race with another tab; the number is on the list either way.
  if (!row) {
    const [now] = await db.select().from(schema.leadSuppressions).where(and(
      eq(schema.leadSuppressions.organisationId, organisationId),
      eq(schema.leadSuppressions.phone, phone),
    ));
    return { row: now!, alreadyThere: true };
  }

  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: v.actorId, action: "lead_suppression.added",
    targetType: "lead_suppression", targetId: row.id, after: row,
  });
  return { row, alreadyThere: false };
}

/** Takes a number off the list. Removing one that is not on it is not an error. */
export async function removeSuppression(
  db: Db,
  organisationId: string,
  input: { id: string; actorId?: string },
): Promise<boolean> {
  const [row] = await db.delete(schema.leadSuppressions).where(and(
    eq(schema.leadSuppressions.organisationId, organisationId),
    eq(schema.leadSuppressions.id, input.id),
  )).returning();
  if (!row) return false;

  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: input.actorId, action: "lead_suppression.removed",
    targetType: "lead_suppression", targetId: row.id, before: row,
  });
  return true;
}

/** Newest first, which is the order somebody adding one wants to see. */
export async function listSuppressions(db: Db, organisationId: string): Promise<SuppressionRow[]> {
  return db.select().from(schema.leadSuppressions)
    .where(eq(schema.leadSuppressions.organisationId, organisationId))
    .orderBy(desc(schema.leadSuppressions.createdAt));
}
