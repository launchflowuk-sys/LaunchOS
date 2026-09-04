import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, asc, eq } from "drizzle-orm";
import { isIPv4, isIPv6 } from "node:net";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertOwned } from "../tenancy/assert-owned.js";

const ACTOR = {
  actorKind: z.enum(["user", "client", "agent", "system"]).default("system"),
  actorId: z.string().optional(),
};

type DnsType = "A" | "AAAA" | "CNAME" | "MX" | "TXT" | "SRV";

// No scheme, no path, no spaces.
const HOSTNAME_VALUE = /^[a-z0-9.-]+$/i;

/**
 * `value` shape depends on `type`, so the enum alone does not catch a malformed
 * record. Checked here rather than left to whatever eventually reads it — the
 * approval-gated `dns_update_record` tool (Plan 4) pushes this value verbatim
 * to a real provider, so garbage caught here never gets that far.
 */
function assertValidDnsValue(type: DnsType, value: string): void {
  switch (type) {
    case "A":
      if (!isIPv4(value)) throw new Error(`dns_record value "${value}" is not a valid IPv4 address for type A`);
      return;
    case "AAAA":
      if (!isIPv6(value)) throw new Error(`dns_record value "${value}" is not a valid IPv6 address for type AAAA`);
      return;
    case "CNAME":
      if (value.includes(" ") || !HOSTNAME_VALUE.test(value)) {
        throw new Error(`dns_record value "${value}" is not a valid hostname for type CNAME`);
      }
      return;
    case "MX": {
      // "<priority> <host>" or host only.
      const parts = value.trim().split(/\s+/);
      const [first, second] = parts;
      const host = parts.length === 2 ? second : first;
      const priorityOk = parts.length === 1 || /^\d+$/.test(first ?? "");
      if (parts.length > 2 || !priorityOk || !host || !HOSTNAME_VALUE.test(host)) {
        throw new Error(`dns_record value "${value}" is not a valid MX value ("<priority> <host>" or host)`);
      }
      return;
    }
    case "TXT":
    case "SRV":
      return; // free-form
  }
}

export const CreateDnsRecordInput = z.object({
  domainId: z.string().uuid(),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]),
  name: z.string().min(1).max(253),
  value: z.string().min(1).max(1000),
  ttl: z.number().int().min(60).max(86400).default(3600),
  proxied: z.boolean().default(false),
  ...ACTOR,
});
export type CreateDnsRecordInput = z.input<typeof CreateDnsRecordInput>;

/**
 * Records what DNS *should* say. Pushing it to a provider is an approval-gated
 * agent tool (`dns_update_record`, Plan 4), never a side effect of this write.
 */
export async function createDnsRecord(db: Db, organisationId: string, input: CreateDnsRecordInput) {
  const { actorKind, actorId, ...fields } = CreateDnsRecordInput.parse(input);
  assertValidDnsValue(fields.type, fields.value);
  await assertOwned(db, organisationId, schema.domains, fields.domainId);
  const [row] = await db.insert(schema.dnsRecords).values({ organisationId, ...fields }).returning();
  await recordAudit(db, organisationId, {
    actorKind, actorId, action: "dns_record.created", targetType: "dns_record", targetId: row!.id, after: row,
  });
  return row!;
}

export const UpdateDnsRecordInput = z.object({
  recordId: z.string().uuid(),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]).optional(),
  name: z.string().min(1).max(253).optional(),
  value: z.string().min(1).max(1000).optional(),
  ttl: z.number().int().min(60).max(86400).optional(),
  proxied: z.boolean().optional(),
  ...ACTOR,
});
export type UpdateDnsRecordInput = z.input<typeof UpdateDnsRecordInput>;

export async function updateDnsRecord(db: Db, organisationId: string, input: UpdateDnsRecordInput) {
  const { recordId, actorKind, actorId, ...patch } = UpdateDnsRecordInput.parse(input);
  const where = and(eq(schema.dnsRecords.id, recordId), eq(schema.dnsRecords.organisationId, organisationId));

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.dnsRecords).where(where);
    if (!before) throw new Error(`dns_record ${recordId} not found in organisation`);
    assertValidDnsValue((patch.type ?? before.type) as DnsType, patch.value ?? before.value);
    const [after] = await tx.update(schema.dnsRecords).set({ ...patch, updatedAt: new Date() }).where(where).returning();
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "dns_record.updated", targetType: "dns_record", targetId: recordId, before, after,
    });
    return after!;
  });
}

export const DeleteDnsRecordInput = z.object({ recordId: z.string().uuid(), ...ACTOR });
export type DeleteDnsRecordInput = z.input<typeof DeleteDnsRecordInput>;

export async function deleteDnsRecord(db: Db, organisationId: string, input: DeleteDnsRecordInput): Promise<void> {
  const { recordId, actorKind, actorId } = DeleteDnsRecordInput.parse(input);
  const where = and(eq(schema.dnsRecords.id, recordId), eq(schema.dnsRecords.organisationId, organisationId));
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(schema.dnsRecords).where(where);
    if (!before) throw new Error(`dns_record ${recordId} not found in organisation`);
    await tx.delete(schema.dnsRecords).where(where);
    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind, actorId, action: "dns_record.deleted", targetType: "dns_record", targetId: recordId, before,
    });
  });
}

export async function listDnsRecords(db: Db, organisationId: string, domainId: string) {
  return db
    .select()
    .from(schema.dnsRecords)
    .where(and(eq(schema.dnsRecords.organisationId, organisationId), eq(schema.dnsRecords.domainId, domainId)))
    .orderBy(asc(schema.dnsRecords.type), asc(schema.dnsRecords.name));
}
