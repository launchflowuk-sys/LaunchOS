import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";

export const ListIncidentsInput = z.object({
  status: z.enum(schema.incidentStatusEnum.enumValues).optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListIncidentsInput = z.input<typeof ListIncidentsInput>;

export interface IncidentListRow {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "acknowledged" | "resolved";
  readonly severity: string;
  readonly openedAt: Date;
  readonly resolvedAt: Date | null;
  readonly clientName: string;
  readonly siteName: string;
  readonly siteUrl: string | null;
  /** How long it has been open, in whole minutes. Null once resolved. */
  readonly openMinutes: number | null;
}

/**
 * What is broken, and for how long.
 *
 * The client's name is joined in rather than left as an id. An incident read
 * aloud as "site 4f2a…" is useless, and the alternative — a second call per row
 * to turn ids into names — is the shape that makes an assistant slow and
 * chatty. One join here saves a round trip per incident there.
 *
 * `summaryMd` is left out: it is the agent's write-up, sometimes long, and a
 * list is for scanning. Anything wanting the detail can fetch the incident.
 */
export async function listIncidents(
  db: Db,
  organisationId: string,
  input: ListIncidentsInput = {},
  now: Date = new Date(),
): Promise<{ incidents: IncidentListRow[]; total: number }> {
  const v = ListIncidentsInput.parse(input);
  const where = and(
    eq(schema.incidents.organisationId, organisationId),
    v.status ? eq(schema.incidents.status, v.status) : undefined,
  );

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: schema.incidents.id,
        title: schema.incidents.title,
        status: schema.incidents.status,
        severity: schema.incidents.severity,
        openedAt: schema.incidents.openedAt,
        resolvedAt: schema.incidents.resolvedAt,
        siteName: schema.sites.name,
        siteUrl: schema.sites.primaryUrl,
        clientName: schema.clients.name,
      })
      .from(schema.incidents)
      .innerJoin(schema.sites, eq(schema.incidents.siteId, schema.sites.id))
      .innerJoin(schema.clients, eq(schema.sites.clientId, schema.clients.id))
      .where(where)
      .orderBy(desc(schema.incidents.openedAt), desc(schema.incidents.id))
      .limit(v.limit)
      .offset(v.offset),
    db.select({ value: count() }).from(schema.incidents).where(where),
  ]);

  return {
    incidents: rows.map((row) => ({
      ...row,
      openMinutes:
        row.resolvedAt === null
          ? Math.max(0, Math.floor((now.getTime() - row.openedAt.getTime()) / 60_000))
          : null,
    })),
    total: total?.value ?? 0,
  };
}
