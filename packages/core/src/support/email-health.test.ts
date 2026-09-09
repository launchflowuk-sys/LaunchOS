import { describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { createClient } from "../clients/create-client.js";
import { emailHealth } from "./email-health.js";

const NOW = new Date("2026-09-09T12:00:00Z");
const WEEK_AGO = new Date("2026-09-02T12:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

async function conversation(db: Db, organisationId: string, clientId: string) {
  const [row] = await db.insert(schema.conversations).values({ organisationId, clientId, subject: "Hello" }).returning();
  return row!;
}

async function message(
  db: Db,
  organisationId: string,
  conversationId: string,
  over: { status: "queued" | "sent" | "failed" | "received"; createdAt?: Date; channel?: string },
) {
  await db.insert(schema.messages).values({
    organisationId,
    conversationId,
    direction: over.status === "received" ? "inbound" : "outbound",
    authorKind: "system",
    body: "x",
    channel: over.channel ?? "email",
    status: over.status,
    createdAt: over.createdAt ?? NOW,
  });
}

describe("emailHealth", () => {
  it("counts what moved this week, and everything that ever failed", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Grays CabLine" });
      const thread = await conversation(db, org.id, client.id);

      await message(db, org.id, thread.id, { status: "received" });
      await message(db, org.id, thread.id, { status: "received" });
      await message(db, org.id, thread.id, { status: "sent" });
      // Older than the window: not this week's traffic, but a failure that
      // nobody has dealt with is still a failure.
      await message(db, org.id, thread.id, { status: "failed", createdAt: new Date("2026-08-01T12:00:00Z") });
      await message(db, org.id, thread.id, { status: "received", createdAt: new Date("2026-08-01T12:00:00Z") });

      const health = await emailHealth(db, org.id, WEEK_AGO, NOW);
      expect(health.received).toBe(2);
      expect(health.sent).toBe(1);
      expect(health.failed).toBe(1);
    });
  });

  /** A queued message nothing is driving is the shape a dead worker takes. */
  it("calls a message stuck only once it has sat there fifteen minutes", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Grays CabLine" });
      const thread = await conversation(db, org.id, client.id);

      await message(db, org.id, thread.id, { status: "queued", createdAt: minutesAgo(2) });
      await message(db, org.id, thread.id, { status: "queued", createdAt: minutesAgo(14) });
      await message(db, org.id, thread.id, { status: "queued", createdAt: minutesAgo(45) });

      expect((await emailHealth(db, org.id, WEEK_AGO, NOW)).stuck).toBe(1);
    });
  });

  it("ignores messages that are not email, because a text is not the mail system", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const client = await createClient(db, org.id, { name: "Grays CabLine" });
      const thread = await conversation(db, org.id, client.id);

      await message(db, org.id, thread.id, { status: "failed", channel: "sms" });
      await message(db, org.id, thread.id, { status: "received", channel: "whatsapp" });

      const health = await emailHealth(db, org.id, WEEK_AGO, NOW);
      expect(health.failed).toBe(0);
      expect(health.received).toBe(0);
    });
  });

  it("says how many active clients have a support address and how many exist", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const routed = await createClient(db, org.id, { name: "Routed" });
      await createClient(db, org.id, { name: "No address" });
      await db.insert(schema.emailIdentities).values({
        organisationId: org.id,
        clientId: routed.id,
        address: `support-${crypto.randomUUID()}@example.test`,
        inboundSecret: crypto.randomUUID(),
      });

      const health = await emailHealth(db, org.id, WEEK_AGO, NOW);
      expect(health.routed).toBe(1);
      expect(health.clients).toBe(2);
    });
  });

  it("never counts another organisation's mail", async () => {
    await withTestDb(async (db) => {
      const mine = await makeOrg(db);
      const theirs = await makeOrg(db);
      const theirClient = await createClient(db, theirs.id, { name: "Not mine" });
      const thread = await conversation(db, theirs.id, theirClient.id);
      await message(db, theirs.id, thread.id, { status: "failed" });
      await message(db, theirs.id, thread.id, { status: "received" });

      const health = await emailHealth(db, mine.id, WEEK_AGO, NOW);
      expect(health).toMatchObject({ received: 0, sent: 0, failed: 0, stuck: 0, routed: 0, clients: 0 });
    });
  });
});
