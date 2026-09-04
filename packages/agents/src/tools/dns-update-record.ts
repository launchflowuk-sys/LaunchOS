import type { DnsProvider } from "@launchos/integrations";
import { recordAudit } from "@launchos/core";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

export function dnsUpdateRecord(dns: DnsProvider) {
  return defineTool({
    name: "dns_update_record",
    description: "Change one DNS record on a domain LaunchFlow manages. Requires human approval.",
    input: z.object({
      domainId: z.string().uuid(),
      type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT"]),
      name: z.string().min(1).max(200),
      value: z.string().min(1).max(500),
      ttl: z.number().int().min(60).max(86400).default(300),
    }),
    risk: "requires_approval",
    // The zone and the client come from our rows; the record itself is what the
    // approver is being asked to release, so it is spelled out in full.
    describeApproval: async (input, ctx) => {
      const [domain] = await ctx.db
        .select({ name: schema.domains.name, clientName: schema.clients.name, provider: schema.domains.dnsProvider })
        .from(schema.domains)
        .innerJoin(schema.clients, eq(schema.domains.clientId, schema.clients.id))
        .where(and(eq(schema.domains.id, input.domainId), eq(schema.domains.organisationId, ctx.organisationId)));
      if (!domain) {
        return {
          title: "Change DNS on a domain that does not exist",
          summary: `No domain ${input.domainId} exists in this organisation. Approving it will fail.`,
        };
      }
      const record = `${input.name}.${domain.name}`;
      return {
        title: `Set the ${input.type} record ${record} to ${input.value}`,
        summary:
          `Approving writes a ${input.type} record on ${domain.name} (${domain.clientName}, via ${domain.provider}): ` +
          `${record} → ${input.value}, TTL ${input.ttl}s. Live DNS changes take effect immediately.`,
        details: {
          client: domain.clientName,
          zone: domain.name,
          provider: domain.provider,
          type: input.type,
          record,
          value: input.value,
          ttlSeconds: input.ttl,
        },
      };
    },
    execute: async (input, ctx) => {
      // The zone is read from our own records, never from the model, so an
      // approved change can only ever touch a domain we manage.
      const [domain] = await ctx.db
        .select({ name: schema.domains.name })
        .from(schema.domains)
        .where(and(eq(schema.domains.id, input.domainId), eq(schema.domains.organisationId, ctx.organisationId)));
      if (!domain) throw new Error(`domain ${input.domainId} not found in organisation`);

      const result = await dns.updateRecord({ zone: domain.name, type: input.type, name: input.name, value: input.value, ttl: input.ttl });
      const [record] = await ctx.db
        .insert(schema.dnsRecords)
        .values({ organisationId: ctx.organisationId, domainId: input.domainId, type: input.type, name: input.name, value: input.value, ttl: input.ttl })
        .returning();
      await recordAudit(ctx.db, ctx.organisationId, {
        actorKind: "agent", actorId: "support-triage", action: "dns_record.updated",
        targetType: "dns_record", targetId: record!.id, after: { ...input, zone: domain.name, provider: dns.name },
      });
      return { ...result, dnsRecordId: record!.id };
    },
  });
}
