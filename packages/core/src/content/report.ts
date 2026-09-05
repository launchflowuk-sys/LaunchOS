import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { ContentChannel, ContentReportItem, ContentReportStats } from "@launchos/db/schema";
import { and, asc, eq, isNull, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { assertClientInOrganisation } from "../tenancy/assert-owned.js";
import { ActorKindSchema, CHANNEL_LABEL, PeriodKeySchema, monthName, shortLondonDate, type ContentReportRow } from "./shared.js";

export const BuildContentReportInput = z.object({
  clientId: z.string().uuid(),
  periodKey: PeriodKeySchema,
  actorKind: ActorKindSchema.default("system"),
  actorId: z.string().min(1).optional(),
});
export type BuildContentReportInput = z.input<typeof BuildContentReportInput>;

const EMPTY_BY_CHANNEL: Record<ContentChannel, number> = { facebook: 0, instagram: 0, blog: 0, gbp: 0 };

/** Neither delivered nor still owed: left out of the "planned" count. */
const NOT_PLANNED: (typeof schema.contentStatusEnum.enumValues)[number][] = ["cancelled", "rejected"];

function renderSummary(clientName: string, periodKey: string, stats: ContentReportStats): string {
  const lines = [`# ${clientName} — content for ${monthName(periodKey)}`, ""];
  if (stats.published === 0) {
    lines.push("No posts were published this month.");
    return lines.join("\n");
  }
  const channels = (Object.keys(CHANNEL_LABEL) as ContentChannel[])
    .filter((c) => stats.byChannel[c] > 0)
    .map((c) => `${stats.byChannel[c]} ${CHANNEL_LABEL[c].toLowerCase()}${stats.byChannel[c] === 1 ? "" : "s"}`);
  lines.push(`${stats.published} of ${stats.planned} planned posts published: ${channels.join(", ")}.`, "", "## Published");
  for (const item of stats.items) {
    const title = item.title ?? CHANNEL_LABEL[item.channel];
    const link = item.externalUrl ? ` — [View post](${item.externalUrl})` : "";
    lines.push(`- ${shortLondonDate(new Date(item.publishedAt))} — ${CHANNEL_LABEL[item.channel]}: ${title}${link}`);
  }
  return lines.join("\n");
}

/**
 * A month's proof of work: every item published in the period, with links,
 * counted per channel and against what was planned. Written as a draft in
 * `content_reports`, one row per (client, month); rebuilding replaces the
 * draft unless it has already been approved or sent, so the monthly cron can
 * re-run and a report the client has seen is never rewritten under them.
 */
export async function buildContentReport(db: Db, organisationId: string, input: BuildContentReportInput): Promise<ContentReportRow> {
  const v = BuildContentReportInput.parse(input);
  await assertClientInOrganisation(db, organisationId, v.clientId);

  return db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [client] = await tx.select({ name: schema.clients.name }).from(schema.clients)
      .where(and(eq(schema.clients.id, v.clientId), eq(schema.clients.organisationId, organisationId)));

    const scope = and(
      eq(schema.contentItems.organisationId, organisationId),
      eq(schema.contentItems.clientId, v.clientId),
      eq(schema.contentItems.periodKey, v.periodKey),
      isNull(schema.contentItems.deletedAt),
    );
    const published = await tx.select().from(schema.contentItems)
      .where(and(scope, eq(schema.contentItems.status, "published")))
      .orderBy(asc(schema.contentItems.publishedAt), asc(schema.contentItems.id));
    const planned = await tx.select({ id: schema.contentItems.id }).from(schema.contentItems)
      .where(and(scope, notInArray(schema.contentItems.status, NOT_PLANNED)));

    const byChannel = { ...EMPTY_BY_CHANNEL };
    const items: ContentReportItem[] = published.map((item) => {
      byChannel[item.channel] += 1;
      return {
        id: item.id,
        channel: item.channel,
        kind: item.kind,
        title: item.title,
        publishedAt: item.publishedAt!.toISOString(),
        externalUrl: item.externalUrl,
      };
    });
    const stats: ContentReportStats = { published: published.length, planned: planned.length, byChannel, items };
    const summaryMd = renderSummary(client!.name, v.periodKey, stats);

    const identity = and(
      eq(schema.contentReports.organisationId, organisationId),
      eq(schema.contentReports.clientId, v.clientId),
      eq(schema.contentReports.periodKey, v.periodKey),
    );
    const [before] = await tx.select().from(schema.contentReports).where(identity);
    const [written] = await tx.insert(schema.contentReports)
      .values({ organisationId, clientId: v.clientId, periodKey: v.periodKey, summaryMd, stats })
      .onConflictDoUpdate({
        target: [schema.contentReports.organisationId, schema.contentReports.clientId, schema.contentReports.periodKey],
        set: { summaryMd, stats, updatedAt: new Date() },
        where: ne(schema.contentReports.status, "sent"),
      })
      .returning();

    if (!written) {
      // Already sent: the conflict update was blocked and nothing changed.
      const [sent] = await tx.select().from(schema.contentReports).where(identity);
      return sent!;
    }
    await recordAudit(tx, organisationId, {
      actorKind: v.actorKind, actorId: v.actorId, action: "content_report.built",
      targetType: "content_report", targetId: written.id, before: before ?? null, after: written,
    });
    return written;
  });
}
