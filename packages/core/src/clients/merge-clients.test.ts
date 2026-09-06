import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq, getTableName, sql } from "drizzle-orm";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { MOVE_SPECS } from "./merge-clients-tables.js";
import { MergeRefused, mergeClients, mergePreview } from "./merge-clients.js";

const PERIOD = { currentPeriodStart: new Date("2026-09-01T00:00:00Z"), currentPeriodEnd: new Date("2026-10-01T00:00:00Z") };

/** Rows in `table` still pointing at `clientId`. */
async function referencing(db: Db, table: string, clientId: string): Promise<number> {
  const rows = await db.execute<{ n: string | number }>(sql`select count(*) as n from ${sql.raw(`"${table}"`)} where client_id = ${clientId}`);
  return Number(rows[0]!.n);
}

/** One row of everything that can hang off a client, on `clientId`. */
async function populate(db: Db, organisationId: string, clientId: string, ownerUserId: string, tag: string) {
  const [portalUser] = await db.insert(schema.user)
    .values({ id: randomUUID(), name: `Portal ${tag}`, email: `portal-${tag}-${randomUUID()}@example.test`, emailVerified: true }).returning();
  await db.insert(schema.clientUsers).values({ organisationId, clientId, userId: portalUser!.id });
  await db.insert(schema.clientContacts).values({ organisationId, clientId, name: `Contact ${tag}`, email: `contact-${tag}@example.test` });
  await db.insert(schema.emailIdentities).values({ organisationId, clientId, address: `${tag}-${randomUUID()}@support.example.test`, inboundSecret: randomUUID() });
  const [sub] = await db.insert(schema.subscriptions).values({ organisationId, clientId, stripeSubscriptionId: `sub_${tag}_${randomUUID()}`, amountPence: 5000, ...PERIOD }).returning();
  const [invoice] = await db.insert(schema.invoices).values({
    organisationId, clientId, subscriptionId: sub!.id, number: `LF-${tag}-${randomUUID().slice(0, 8)}`, dueAt: PERIOD.currentPeriodEnd,
    subtotalPence: 5000, totalPence: 6000,
  }).returning();
  await db.insert(schema.payments).values({ organisationId, clientId, invoiceId: invoice!.id, amountPence: 6000, provider: "bank", providerRef: randomUUID(), status: "succeeded" });
  const [site] = await db.insert(schema.sites).values({ organisationId, clientId, name: `Site ${tag}`, primaryUrl: `https://${tag}.example.test` }).returning();
  await db.insert(schema.domains).values({ organisationId, clientId, siteId: site!.id, name: `${tag}-${randomUUID().slice(0, 6)}.example.test` });
  const [conversation] = await db.insert(schema.conversations).values({ organisationId, clientId, subject: `Thread ${tag}` }).returning();
  await db.insert(schema.messages).values({ organisationId, conversationId: conversation!.id, direction: "outbound", authorKind: "user", body: "hello" });
  await db.insert(schema.tickets).values({ organisationId, clientId, conversationId: conversation!.id, subject: `Ticket ${tag}` });
  await db.insert(schema.tasks).values({ organisationId, clientId, phase: "recurring", title: `Task ${tag}` });
  await db.insert(schema.activityEvents).values({ organisationId, clientId, actorKind: "system", kind: "note", title: `Event ${tag}` });
  await db.insert(schema.meetings).values({
    organisationId, clientId, hostUserId: ownerUserId, guestName: tag, guestEmail: `${tag}@example.test`,
    startsAt: new Date(`2026-09-10T${tag === "keep" ? "09" : "10"}:00:00Z`), endsAt: new Date(`2026-09-10T${tag === "keep" ? "09" : "10"}:30:00Z`), provider: "mock", joinUrl: "https://meet.example.test", rescheduleToken: randomUUID(),
  });
  await db.insert(schema.leads).values({ organisationId, clientId, name: `Lead ${tag}`, status: "converted" });
  await db.insert(schema.adAccounts).values({ organisationId, clientId, platform: "google", externalId: `acct-${tag}-${randomUUID().slice(0, 6)}`, name: `Ads ${tag}` });
  await db.insert(schema.contentBriefs).values({ organisationId, clientId, tone: tag });
  await db.insert(schema.contentChannels).values({ organisationId, clientId, channel: "facebook", externalId: `page-${tag}` });
  await db.insert(schema.contentItems).values({ organisationId, clientId, channel: "facebook", kind: "social_post", periodKey: "2026-09", title: tag, metadata: { slot: 1 } });
  await db.insert(schema.contentAssets).values({ organisationId, clientId, path: `${tag}.jpg`, mime: "image/jpeg" });
  await db.insert(schema.contentReports).values({ organisationId, clientId, periodKey: "2026-08", summaryMd: tag });
  await db.insert(schema.clientReports).values({ organisationId, clientId, periodStart: "2026-08-01", periodEnd: "2026-08-31", summaryMd: tag });
  return { portalUserId: portalUser!.id };
}

describe("mergeClients", () => {
  it("re-points every table at the kept client, converts the duplicate's Stripe customer to a payment account, appends notes, archives and audits", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId: keepId, ownerUserId } = await seedOrgWithClient(db);
      await db.update(schema.clients).set({ notes: "Kept notes.", email: null, phone: "01375 000000" }).where(eq(schema.clients.id, keepId));
      const [dup] = await db.insert(schema.clients).values({
        organisationId, name: "Safiullah Mansoor", slug: `dup-${randomUUID()}`, supportEmail: `dup-${randomUUID()}@support.example.test`,
        email: "safi@graystowntaxis.example", notes: "Ad management £50/month.",
      }).returning();
      const mergeId = dup!.id;
      await db.insert(schema.billingProfiles).values({ organisationId, clientId: keepId, stripeCustomerId: "cus_kept" });
      await db.insert(schema.clientPaymentAccounts).values({ organisationId, clientId: keepId, externalCustomerId: "cus_kept", isPrimary: true });
      await db.insert(schema.billingProfiles).values({ organisationId, clientId: mergeId, billingName: "Safiullah", stripeCustomerId: "cus_dup" });
      // A payment account the backfill would have made, plus one linked later.
      await db.insert(schema.clientPaymentAccounts).values([
        { organisationId, clientId: mergeId, externalCustomerId: "cus_dup", isPrimary: true },
        { organisationId, clientId: mergeId, externalCustomerId: "cus_dup_2" },
      ]);
      await populate(db, organisationId, mergeId, ownerUserId, "dup");

      const preview = await mergePreview(db, organisationId, { keepId, mergeId });
      expect(preview.moved).toMatchObject({ client_payment_accounts: 2, subscriptions: 1, invoices: 1, payments: 1, sites: 1, tickets: 1, tasks: 1, content_briefs: 1 });
      expect(preview.dropped).toEqual({ billing_profiles: 1 });
      expect(preview.left).toEqual({});
      expect(preview.warnings).toContain("Both clients have a Stripe customer; cus_dup becomes an extra payment account of the kept client.");
      // Preview writes nothing.
      expect((await db.select().from(schema.clients).where(eq(schema.clients.id, mergeId)))[0]!.status).toBe("active");

      const result = await mergeClients(db, organisationId, { keepId, mergeId, actorId: ownerUserId });

      expect(result.moved).toEqual(preview.moved);
      expect(result.dropped).toEqual(preview.dropped);
      expect(result.left).toEqual({});
      for (const spec of MOVE_SPECS) {
        expect({ table: spec.key, stillReferencing: await referencing(db, getTableName(spec.table), mergeId) }).toEqual({ table: spec.key, stillReferencing: 0 });
      }
      expect(await referencing(db, "billing_profiles", mergeId)).toBe(0);
      // The list of tables with a client_id, from the database itself, is exactly what the merge covers.
      const columns = await db.execute<{ table_name: string }>(sql`
        select table_name from information_schema.columns where table_schema = 'public' and column_name = 'client_id' order by table_name
      `);
      expect(columns.map((c) => c.table_name).sort()).toEqual([...MOVE_SPECS.map((s) => s.key), "billing_profiles"].sort());

      expect(result.kept).toMatchObject({ name: "Grays CabLine", email: "safi@graystowntaxis.example", phone: "01375 000000", status: "active" });
      expect(result.kept.notes).toMatch(/^Kept notes\.\n\n--- Merged from "Safiullah Mansoor" on \d{4}-\d{2}-\d{2} ---\n\nAd management £50\/month\.$/);
      expect(result.merged).toMatchObject({ status: "archived", metadata: { mergedInto: keepId } });

      const accounts = await db.select().from(schema.clientPaymentAccounts).where(eq(schema.clientPaymentAccounts.clientId, keepId));
      expect(accounts.map((a) => [a.externalCustomerId, a.isPrimary]).sort()).toEqual([["cus_dup", false], ["cus_dup_2", false], ["cus_kept", true]]);
      const [profile] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, keepId));
      expect(profile!.stripeCustomerId).toBe("cus_kept");
      // Messages followed their conversation; nothing on the moved thread was lost.
      const [thread] = await db.select().from(schema.conversations).where(eq(schema.conversations.clientId, keepId));
      expect(await db.select().from(schema.messages).where(eq(schema.messages.conversationId, thread!.id))).toHaveLength(1);

      const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.action, "client.merged")));
      expect(audits.map((a) => a.targetId).sort()).toEqual([keepId, mergeId].sort());
      expect(audits.every((a) => a.actorKind === "user" && a.actorId === ownerUserId)).toBe(true);
      const timeline = await db.select().from(schema.activityEvents).where(and(eq(schema.activityEvents.clientId, keepId), eq(schema.activityEvents.kind, "client.merged")));
      expect(timeline).toHaveLength(1);
      expect(timeline[0]!.title).toBe('Merged "Safiullah Mansoor" into this client');
    });
  });

  it("leaves per-client rows the kept client already has, drops duplicate portal logins and the duplicate's support address, and moves the billing profile when the kept client has none", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId: keepId, ownerUserId } = await seedOrgWithClient(db);
      const [dup] = await db.insert(schema.clients).values({ organisationId, name: "Dup", slug: `dup-${randomUUID()}`, packageId: null }).returning();
      const mergeId = dup!.id;
      await db.insert(schema.billingProfiles).values({ organisationId, clientId: mergeId, stripeCustomerId: "cus_only_dup" });
      const { portalUserId } = await populate(db, organisationId, keepId, ownerUserId, "keep");
      await populate(db, organisationId, mergeId, ownerUserId, "dup");
      // The same person has a portal login on both.
      await db.insert(schema.clientUsers).values({ organisationId, clientId: mergeId, userId: portalUserId });
      await db.update(schema.clients).set({ packageId: null }).where(eq(schema.clients.id, keepId));
      const [pkg] = await db.select().from(schema.packages).where(eq(schema.packages.organisationId, organisationId));
      await db.update(schema.clients).set({ packageId: pkg!.id }).where(eq(schema.clients.id, mergeId));

      const result = await mergeClients(db, organisationId, { keepId, mergeId });

      expect(result.moved).toMatchObject({ billing_profiles: 1, client_users: 1, subscriptions: 1, tasks: 1 });
      expect(result.moved["content_items"]).toBeUndefined();
      expect(result.left).toEqual({ content_briefs: 1, content_channels: 1, content_items: 1, content_reports: 1, client_reports: 1 });
      expect(result.dropped).toEqual({ client_users: 1, email_identities: 1 });
      expect(result.kept.packageId).toBe(pkg!.id);
      expect(await referencing(db, "content_briefs", mergeId)).toBe(1);
      expect(await referencing(db, "email_identities", mergeId)).toBe(0);
      expect(await referencing(db, "client_users", mergeId)).toBe(0);
      expect(await db.select().from(schema.clientUsers).where(eq(schema.clientUsers.clientId, keepId))).toHaveLength(2);
      const [profile] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, keepId));
      expect(profile!.stripeCustomerId).toBe("cus_only_dup");
      // With no billing profile, the kept client's oldest account becomes primary; here the moved one.
      const accounts = await db.select().from(schema.clientPaymentAccounts).where(eq(schema.clientPaymentAccounts.clientId, keepId));
      expect(accounts).toHaveLength(0);
    });
  });

  it("refuses to merge a client into itself, into an archived client, or across organisations", async () => {
    await withTestDb(async (db) => {
      const mine = await seedOrgWithClient(db);
      const theirs = await seedOrgWithClient(db);
      const [archived] = await db.insert(schema.clients).values({ organisationId: mine.organisationId, name: "Old", slug: `old-${randomUUID()}`, status: "archived" }).returning();

      await expect(mergeClients(db, mine.organisationId, { keepId: mine.clientId, mergeId: mine.clientId })).rejects.toThrow(MergeRefused);
      await expect(mergePreview(db, mine.organisationId, { keepId: archived!.id, mergeId: mine.clientId })).rejects.toMatchObject({ reason: "keep_archived" });
      await expect(mergeClients(db, mine.organisationId, { keepId: mine.clientId, mergeId: theirs.clientId })).rejects.toMatchObject({ reason: "not_found" });
      await expect(mergeClients(db, theirs.organisationId, { keepId: mine.clientId, mergeId: theirs.clientId })).rejects.toMatchObject({ reason: "not_found" });
      // An archived duplicate may still be merged away.
      const result = await mergeClients(db, mine.organisationId, { keepId: mine.clientId, mergeId: archived!.id });
      expect(result.merged.metadata).toMatchObject({ mergedInto: mine.clientId });
      const [theirClient] = await db.select().from(schema.clients).where(eq(schema.clients.id, theirs.clientId));
      expect(theirClient!.status).toBe("active");
    });
  });
});
