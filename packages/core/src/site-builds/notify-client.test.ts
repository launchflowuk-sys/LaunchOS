import { MockEmailAdapter } from "@launchos/channels";
import type { EmailAdapter, SendResult } from "@launchos/channels";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { notifySiteBuildClient } from "./notify-client.js";
import { advanceSiteBuild, startSiteBuild } from "./site-builds.js";

const DOMAIN = "taylor-plumbing.review.launchflow.co.uk";
const ENV = { MAIL_FROM: "hello@launchflow.co.uk", APP_URL: "https://os.launchflow.co.uk" } as NodeJS.ProcessEnv;

class FailingEmailAdapter implements EmailAdapter {
  readonly name = "mock" as const;
  async send(): Promise<SendResult> {
    throw new Error("535 Authentication unsuccessful");
  }
}

async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `t-${crypto.randomUUID()}` }).returning();
  return org!;
}

/** A build sitting at `approved` with an enquiry behind it — the usual shape. */
async function approvedBuild(db: Db, orgId: string, email: string | null = "sam@taylorplumbing.co.uk") {
  const [lead] = await db
    .insert(schema.leads)
    .values({ organisationId: orgId, name: "Sam Taylor", ...(email ? { email } : {}) })
    .returning();
  const { build } = await startSiteBuild(db, orgId, { domain: DOMAIN, leadId: lead!.id });
  await advanceSiteBuild(db, orgId, build.id, "review", { websiteUrl: `https://${DOMAIN}` });
  return advanceSiteBuild(db, orgId, build.id, "approved");
}

describe("notifySiteBuildClient", () => {
  it("emails the enquiry the address of their site and records that it went", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const build = await approvedBuild(db, org.id);
      const email = new MockEmailAdapter();

      const result = await notifySiteBuildClient(db, org.id, { buildId: build.id, actorId: "u1" }, email, ENV);

      expect(result.sent).toBe(true);
      expect(email.sent).toHaveLength(1);
      expect(email.sent[0]!.to).toBe("sam@taylorplumbing.co.uk");
      expect(email.sent[0]!.text).toContain(DOMAIN);
      const [row] = await db.select().from(schema.siteBuilds).where(eq(schema.siteBuilds.id, build.id));
      expect(row!.stage).toBe("notified");
      expect(row!.notifiedAt).not.toBeNull();
    });
  });

  it("prefers the client's address over the enquiry's once there is a client", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const build = await approvedBuild(db, org.id);
      const [client] = await db
        .insert(schema.clients)
        .values({
          organisationId: org.id,
          name: "Taylor Plumbing",
          slug: `taylor-${crypto.randomUUID()}`,
          email: "accounts@taylorplumbing.co.uk",
        })
        .returning();
      await db.update(schema.siteBuilds).set({ clientId: client!.id }).where(eq(schema.siteBuilds.id, build.id));
      const email = new MockEmailAdapter();

      await notifySiteBuildClient(db, org.id, { buildId: build.id, actorId: "u1" }, email, ENV);

      expect(email.sent[0]!.to).toBe("accounts@taylorplumbing.co.uk");
    });
  });

  /** Two presses of one button is the ordinary case, not an exotic one. */
  it("does not send twice", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const build = await approvedBuild(db, org.id);
      const email = new MockEmailAdapter();

      await notifySiteBuildClient(db, org.id, { buildId: build.id, actorId: "u1" }, email, ENV);
      const second = await notifySiteBuildClient(db, org.id, { buildId: build.id, actorId: "u1" }, email, ENV);

      expect(second.sent).toBe(false);
      expect(email.sent).toHaveLength(1);
    });
  });

  it("refuses a build nobody has approved", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const [lead] = await db
        .insert(schema.leads)
        .values({ organisationId: org.id, name: "Sam", email: "sam@example.com" })
        .returning();
      const { build } = await startSiteBuild(db, org.id, { domain: DOMAIN, leadId: lead!.id });
      await advanceSiteBuild(db, org.id, build.id, "review");
      const email = new MockEmailAdapter();

      await expect(
        notifySiteBuildClient(db, org.id, { buildId: build.id, actorId: "u1" }, email, ENV),
      ).rejects.toThrow(/approved/);
      expect(email.sent).toHaveLength(0);
    });
  });

  /**
   * An address is a thing a person can go and fix. Losing the approval because
   * of one would mean doing the whole review again.
   */
  it("leaves the build approved when there is no address to send to", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const build = await approvedBuild(db, org.id, null);
      const email = new MockEmailAdapter();

      await expect(
        notifySiteBuildClient(db, org.id, { buildId: build.id, actorId: "u1" }, email, ENV),
      ).rejects.toThrow(/email address/);

      const [row] = await db.select().from(schema.siteBuilds).where(eq(schema.siteBuilds.id, build.id));
      expect(row!.stage).toBe("approved");
      expect(row!.notifiedAt).toBeNull();
    });
  });

  /**
   * A refusal and a timeout look the same from here, so the claim is kept and
   * the words are put where a person will see them.
   */
  it("keeps the claim when the mail server refuses, and says so on the row", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const build = await approvedBuild(db, org.id);

      await expect(
        notifySiteBuildClient(db, org.id, { buildId: build.id, actorId: "u1" }, new FailingEmailAdapter(), ENV),
      ).rejects.toThrow(/535/);

      const [row] = await db.select().from(schema.siteBuilds).where(eq(schema.siteBuilds.id, build.id));
      expect(row!.stage).toBe("notified");
      expect(row!.error).toContain("535");
      expect(row!.error).toContain("sam@taylorplumbing.co.uk");
    });
  });

  it("lets a person try again after a failed send, and clears the failure", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const build = await approvedBuild(db, org.id);
      await notifySiteBuildClient(db, org.id, { buildId: build.id, actorId: "u1" }, new FailingEmailAdapter(), ENV)
        .catch(() => undefined);
      const email = new MockEmailAdapter();

      const result = await notifySiteBuildClient(db, org.id, { buildId: build.id, actorId: "u1" }, email, ENV);

      expect(result.sent).toBe(true);
      expect(email.sent).toHaveLength(1);
      const [row] = await db.select().from(schema.siteBuilds).where(eq(schema.siteBuilds.id, build.id));
      expect(row!.error).toBeNull();
    });
  });

  it("puts Shoji's own line into the message when he writes one", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const build = await approvedBuild(db, org.id);
      const email = new MockEmailAdapter();

      await notifySiteBuildClient(
        db,
        org.id,
        { buildId: build.id, actorId: "u1", note: "I have used the photos from your Facebook page." },
        email,
        ENV,
      );

      expect(email.sent[0]!.text).toContain("photos from your Facebook page");
    });
  });

  it("audits who told the client, and when", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const build = await approvedBuild(db, org.id);

      await notifySiteBuildClient(db, org.id, { buildId: build.id, actorId: "u1" }, new MockEmailAdapter(), ENV);

      const [audit] = await db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, org.id), eq(schema.auditLog.action, "site_build.notified")));
      expect(audit!.actorId).toBe("u1");
      expect(audit!.actorKind).toBe("user");
    });
  });
});
