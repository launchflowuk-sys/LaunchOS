import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { recordActivity } from "../activity/record-activity.js";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

const ACTOR = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
};

export const CreateContactInput = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  role: z.string().max(100).optional(),
  isPrimary: z.boolean().default(false),
  ...ACTOR,
});
export type CreateContactInput = z.input<typeof CreateContactInput>;

/** Demotes every other primary contact for the client, inside the caller's transaction. */
async function demoteOthers(tx: Db, organisationId: string, clientId: string, keepId: string | null) {
  await tx
    .update(schema.clientContacts)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(
      and(
        eq(schema.clientContacts.organisationId, organisationId),
        eq(schema.clientContacts.clientId, clientId),
        eq(schema.clientContacts.isPrimary, true),
        keepId ? ne(schema.clientContacts.id, keepId) : undefined,
      ),
    );
}

export async function createContact(db: Db, organisationId: string, input: CreateContactInput) {
  const { clientId, actorKind, actorId, ...fields } = CreateContactInput.parse(input);
  await assertOwned(db, organisationId, schema.clients, clientId);

  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    if (fields.isPrimary) await demoteOthers(inner, organisationId, clientId, null);
    const [row] = await tx.insert(schema.clientContacts).values({ organisationId, clientId, ...fields }).returning();
    await recordActivity(inner, organisationId, {
      clientId, actorKind, actorId, kind: "contact.added",
      title: `Contact added: ${row!.name}`, link: `/clients/${clientId}?tab=contacts`,
    });
    await recordAudit(inner, organisationId, {
      actorKind, actorId, action: "contact.created", targetType: "client_contact", targetId: row!.id, after: row,
    });
    return row!;
  });
}

export const UpdateContactInput = z.object({
  contactId: z.string().uuid(),
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().nullish(),
  phone: z.string().max(40).nullish(),
  role: z.string().max(100).nullish(),
  isPrimary: z.boolean().optional(),
  ...ACTOR,
});
export type UpdateContactInput = z.input<typeof UpdateContactInput>;

export async function updateContact(db: Db, organisationId: string, input: UpdateContactInput) {
  const { contactId, actorKind, actorId, ...patch } = UpdateContactInput.parse(input);
  const where = and(eq(schema.clientContacts.id, contactId), eq(schema.clientContacts.organisationId, organisationId));

  return db.transaction(async (tx) => {
    const inner = tx as unknown as Db;
    const [before] = await tx.select().from(schema.clientContacts).where(where);
    if (!before) throw new Error(`client_contact ${contactId} not found in organisation`);
    if (patch.isPrimary) await demoteOthers(inner, organisationId, before.clientId, contactId);
    const [after] = await tx.update(schema.clientContacts).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    await recordAudit(inner, organisationId, {
      actorKind, actorId, action: "contact.updated", targetType: "client_contact", targetId: contactId, before, after,
    });
    return after!;
  });
}

export const DeleteContactInput = z.object({ contactId: z.string().uuid(), ...ACTOR });
export type DeleteContactInput = z.input<typeof DeleteContactInput>;

export async function deleteContact(db: Db, organisationId: string, input: DeleteContactInput): Promise<void> {
  const { contactId, actorKind, actorId } = DeleteContactInput.parse(input);
  const where = and(eq(schema.clientContacts.id, contactId), eq(schema.clientContacts.organisationId, organisationId));
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.clientContacts).where(where);
    if (!before) throw new Error(`client_contact ${contactId} not found in organisation`);
    await tx.delete(schema.clientContacts).where(where);
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "contact.deleted", targetType: "client_contact", targetId: contactId, before,
    });
  });
}

export async function listContacts(db: Db, organisationId: string, clientId: string) {
  return db
    .select()
    .from(schema.clientContacts)
    .where(and(eq(schema.clientContacts.organisationId, organisationId), eq(schema.clientContacts.clientId, clientId)))
    .orderBy(desc(schema.clientContacts.isPrimary), asc(schema.clientContacts.name));
}
