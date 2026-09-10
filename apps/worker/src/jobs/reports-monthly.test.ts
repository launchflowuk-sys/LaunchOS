import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { buildMonthlyReport, decideApproval } from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { runMonthlyReports } from "./reports-monthly.js";

/** 07:45 on 1 September, Europe/London — the cron's own clock, in BST. */
const NOW = new Date("2026-09-01T06:45:00Z");

const quiet = () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() });

async function organisation(db: Db, slug: string) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `${slug}-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });
  return { orgId: org!.id, ownerId };
}

/**
 * A client with an address, so the send gate has somebody to write to, and a
 * live retainer, because the report is now timed to a client's *payment* date
 * — a client with no subscription has no such date and is deliberately left
 * out. The period starts on 5 September, so at NOW (1 September) the August
 * report is due: the month has ended and payment is four days away.
 */
async function client(db: Db, organisationId: string, name: string, opts: { subscribed?: boolean } = {}) {
  const [row] = await db.insert(schema.clients).values({
    organisationId, name, slug: `${name.toLowerCase()}-${randomUUID()}`, email: `${randomUUID()}@grays.test`,
  }).returning();
  if (opts.subscribed !== false) {
    await db.insert(schema.subscriptions).values({
      organisationId, clientId: row!.id, status: "active",
      currentPeriodStart: new Date("2026-09-05T00:00:00Z"),
      currentPeriodEnd: new Date("2026-10-05T00:00:00Z"),
      amountPence: 20000, currency: "GBP",
    });
  }
  return row!;
}

function sendCards(db: Db, organisationId: string) {
  return db.select().from(schema.approvals).where(and(
    eq(schema.approvals.organisationId, organisationId),
    sql`${schema.approvals.payload}->>'action' = 'monthly_report_send'`,
  ));
}

describe("runMonthlyReports", () => {
  it("compiles the London month, renders the PDF and raises one send card per active client", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await organisation(db, "mr");
      const active = await client(db, orgId, "Grays");
      await db.insert(schema.clients).values({
        organisationId: orgId, name: "Gone", slug: `gone-${randomUUID()}`, status: "archived",
      });

      const result = await runMonthlyReports(db, orgId, { now: NOW, logger: quiet() });

      expect(result).toEqual({
        periodStart: "2026-08-01", monthName: "August 2026",
        clients: 1, reports: 1, rendered: 1, requested: 1, skipped: 0, failed: 0,
      });

      const [report] = await db.select().from(schema.clientReports).where(eq(schema.clientReports.clientId, active.id));
      // The London month, not the UTC one: in BST a UTC month begins at 01:00
      // local, which would file August under 2026-07-31.
      expect(report!.periodStart).toBe("2026-08-01");
      expect(report!.periodEnd).toBe("2026-08-31");
      // A draft until a person approves the send. Nothing has reached the client.
      expect(report!.status).toBe("draft");
      expect(report!.documentId).not.toBeNull();

      const [document] = await db.select().from(schema.documents).where(eq(schema.documents.id, report!.documentId!));
      expect(document).toMatchObject({ kind: "monthly_report", subjectType: "client_report", subjectId: report!.id });

      const cards = await sendCards(db, orgId);
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ kind: "report_send", status: "pending" });
      expect(cards[0]!.payload).toMatchObject({ reportId: report!.id, monthName: "August 2026" });
      // The gate is the whole point: no message row exists until Shoji decides.
      expect(await db.select().from(schema.messages).where(eq(schema.messages.organisationId, orgId))).toHaveLength(0);
    });
  });

  it("is safe to run twice: one report, one document, one card", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await organisation(db, "mr2");
      await client(db, orgId, "Grays");

      const first = await runMonthlyReports(db, orgId, { now: NOW, logger: quiet() });
      const second = await runMonthlyReports(db, orgId, { now: NOW, logger: quiet() });

      expect(first.requested).toBe(1);
      // The second pass rebuilds and re-renders the draft — the document
      // follows the row — but the card is already waiting, so it does not ask.
      expect(second).toMatchObject({ reports: 1, rendered: 1, requested: 0, skipped: 0, failed: 0 });
      expect(await db.select().from(schema.clientReports).where(eq(schema.clientReports.organisationId, orgId))).toHaveLength(1);
      expect(await sendCards(db, orgId)).toHaveLength(1);
    });
  });

  it("leaves a published report alone: not rebuilt, not re-rendered, not asked about", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await organisation(db, "mr3");
      const only = await client(db, orgId, "Grays");
      await runMonthlyReports(db, orgId, { now: NOW, logger: quiet() });
      await db.update(schema.clientReports).set({ status: "published" })
        .where(eq(schema.clientReports.clientId, only.id));

      const result = await runMonthlyReports(db, orgId, { now: NOW, logger: quiet() });

      // A published report is one the client has been sent; the upsert refuses
      // to rewrite it, so `reports` must not claim it was rebuilt.
      expect(result).toMatchObject({ clients: 1, reports: 0, rendered: 0, requested: 0, skipped: 1, failed: 0 });
    });
  });

  it("does not put a rejected send back in front of the owner", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId } = await organisation(db, "mr4");
      await client(db, orgId, "Grays");
      await runMonthlyReports(db, orgId, { now: NOW, logger: quiet() });
      const [card] = await sendCards(db, orgId);
      await decideApproval(db, orgId, { approvalId: card!.id, decision: "rejected", decidedByUserId: ownerId });

      const result = await runMonthlyReports(db, orgId, { now: NOW, logger: quiet() });

      expect(result.requested).toBe(0);
      expect(await sendCards(db, orgId)).toHaveLength(1);
    });
  });

  /**
   * The reason this became per-client. A client who pays on the 20th used to be
   * sent August's report on the 1st, three weeks before the invoice it is meant
   * to justify — and had forgotten it by the time the money moved.
   */
  it("waits for a client whose payment is later in the month", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await organisation(db, "mr-late");
      const [late] = await db.insert(schema.clients)
        .values({ organisationId: orgId, name: "Late", slug: `late-${randomUUID()}`, email: `${randomUUID()}@grays.test` })
        .returning();
      await db.insert(schema.subscriptions).values({
        organisationId: orgId, clientId: late!.id, status: "active",
        currentPeriodStart: new Date("2026-09-20T00:00:00Z"),
        currentPeriodEnd: new Date("2026-10-20T00:00:00Z"),
        amountPence: 20000, currency: "GBP",
      });

      // 1 September: nothing owed yet, their report is due on the 15th.
      expect(await runMonthlyReports(db, orgId, { now: NOW, logger: quiet() })).toMatchObject({ clients: 0, reports: 0 });

      const due = await runMonthlyReports(db, orgId, {
        now: new Date("2026-09-15T06:45:00Z"),
        logger: quiet(),
      });
      expect(due).toMatchObject({ clients: 1, reports: 1 });
    });
  });

  it("leaves out a client with no live retainer, who has no payment date to aim at", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await organisation(db, "mr-none");
      await client(db, orgId, "Unsubscribed", { subscribed: false });

      expect(await runMonthlyReports(db, orgId, { now: NOW, logger: quiet() })).toMatchObject({ clients: 0, reports: 0 });
    });
  });

  it("logs a client with no address rather than failing the run", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await organisation(db, "mr5");
      // A retainer, so the client is due a report at all, but no address for it
      // to be sent to — which is the case under test.
      const [silent] = await db.insert(schema.clients)
        .values({ organisationId: orgId, name: "Silent", slug: `silent-${randomUUID()}` })
        .returning();
      await db.insert(schema.subscriptions).values({
        organisationId: orgId, clientId: silent!.id, status: "active",
        currentPeriodStart: new Date("2026-09-05T00:00:00Z"),
        currentPeriodEnd: new Date("2026-10-05T00:00:00Z"),
        amountPence: 20000, currency: "GBP",
      });
      const logger = quiet();

      const result = await runMonthlyReports(db, orgId, { now: NOW, logger });

      expect(result).toMatchObject({ clients: 1, reports: 1, rendered: 1, requested: 0, failed: 0 });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ organisationId: orgId }),
        "monthly report has nobody to send to",
      );
      expect(await sendCards(db, orgId)).toHaveLength(0);
    });
  });

  it("reports every other client when one throws, then fails the job", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await organisation(db, "mr6");
      const bad = await client(db, orgId, "Bad");
      const good = await client(db, orgId, "Good");

      // Everything real except this one client, which blows up the way a
      // deadlock or a browser that will not start would.
      const build = vi.fn(async (...args: Parameters<typeof buildMonthlyReport>) => {
        if (args[2].clientId === bad.id) throw new Error("upsert deadlock");
        return buildMonthlyReport(...args);
      });
      const logger = quiet();

      await expect(runMonthlyReports(db, orgId, { now: NOW, build, logger })).rejects.toThrow(AggregateError);

      // The throw discards the return value, so the counts have to be logged
      // before it or the operator never learns how many clients did get a report.
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ organisationId: orgId, clients: 2, reports: 1, requested: 1, failed: 1 }),
        "monthly reports",
      );
      const rows = await db.select().from(schema.clientReports).where(eq(schema.clientReports.organisationId, orgId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.clientId).toBe(good.id);
    });
  });
});
