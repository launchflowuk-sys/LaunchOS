import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createProject, periodKeyFor, renderDeliveryReport, setEnqueue, signOffDelivery } from "@launchos/core";
import type { PackageIncludes } from "@launchos/db/schema";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { handleDeliveryFollowOn } from "./delivery-follow-on.js";
import type { BossSender } from "./dispatch-event.js";

setEnqueue(async () => {});

const storage = await mkdtemp(join(tmpdir(), "launchos-delivery-"));
const ENV = {
  STORAGE_DIR: storage,
  APP_URL: "https://os.launchflow.test",
  SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
  PDF_RENDERER: "mock",
  NODE_ENV: "test",
} as NodeJS.ProcessEnv;

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = new Date("2026-09-11T16:00:00Z");
const INCLUDES: PackageIncludes = {
  website: true, seo: false, ads: false, socialPostsPerMonth: 2, blogPostsPerMonth: 0, gbpUpdatesPerMonth: 0,
};

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

function fakeBoss() {
  const send = vi.fn<(queue: string, data: unknown, options?: unknown) => Promise<string>>().mockResolvedValue("job-id");
  return { boss: { send } as unknown as BossSender, send };
}

/**
 * A finished build on a retainer: a package with a content quota, a live
 * subscription, one recurring template and a project ready to hand over.
 */
async function fixture(db: Db, options: { withSubscription?: boolean } = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `dfo-${randomUUID()}` }).returning();
  const organisationId = org!.id;
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Shoji", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId, userId: ownerId, role: "owner", status: "active" });

  const [pkg] = await db.insert(schema.packages).values({
    organisationId, name: "Care", slug: `care-${randomUUID()}`, monthlyPricePence: 14900, includes: INCLUDES,
  }).returning();
  const [client] = await db.insert(schema.clients).values({
    organisationId, name: "KD Landscapes", slug: `kd-${randomUUID()}`, email: "kelly@kdlandscapes.test", packageId: pkg!.id,
  }).returning();
  await db.insert(schema.taskTemplates).values({
    organisationId, packageId: pkg!.id, phase: "recurring", kind: "social", recurrence: "monthly",
    title: "Write and post", sortOrder: 1,
  });
  if (options.withSubscription !== false) {
    await db.insert(schema.subscriptions).values({
      organisationId, clientId: client!.id, packageId: pkg!.id, status: "active",
      currentPeriodStart: NOW, currentPeriodEnd: new Date("2026-10-11T16:00:00Z"),
      amountPence: 14900, currency: "GBP",
    });
  }

  const created = await createProject(db, organisationId, {
    clientId: client!.id, name: "Website for KD Landscapes", status: "active",
    actorKind: "user", actorId: ownerId, now: NOW,
  });
  return { organisationId, ownerId, clientId: client!.id, project: created.project, packageId: pkg!.id };
}

/** Sends the handover and has the client sign it, the way the public page does. */
async function signOff(db: Db, organisationId: string, projectId: string) {
  const rendered = await renderDeliveryReport(db, organisationId, { projectId, actorKind: "system" }, undefined, ENV);
  const token = rendered.report.project.signOffToken!;
  return signOffDelivery(db, organisationId, {
    token, signedName: "Kelly Dixon", signedEmail: "kelly@kdlandscapes.test", now: NOW,
  });
}

describe("the delivery follow-on", () => {
  it("countersigns the handover and starts the care plan: recurring tasks, the month's slots, one writer run", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const { signOff: signature } = await signOff(db, f.organisationId, f.project.id);
      expect(signature.documentId).toBeNull();
      const { boss, send } = fakeBoss();

      const result = await handleDeliveryFollowOn({ db, boss, env: ENV, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id,
      });

      expect(result).toMatchObject({
        projectId: f.project.id, clientId: f.clientId, countersignSkipped: null, contentSkipped: null, writerQueued: true,
      });
      expect(result.countersignedDocumentId).not.toBeNull();

      // The countersigned copy is filed against the signature, and it is a
      // second document — what they signed stays on the project.
      const [countersigned] = await db.select().from(schema.deliverySignOffs)
        .where(eq(schema.deliverySignOffs.id, signature.id));
      expect(countersigned!.documentId).toBe(result.countersignedDocumentId);
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, f.project.id));
      expect(project!.deliveryReportDocumentId).not.toBe(countersigned!.documentId);

      // Two social posts a month means two recurring tasks and two slots,
      // today rather than at 06:00 tomorrow.
      const tasks = await db.select().from(schema.tasks).where(and(
        eq(schema.tasks.organisationId, f.organisationId), eq(schema.tasks.phase, "recurring"),
      ));
      expect(tasks).toHaveLength(2);
      const periodKey = periodKeyFor(new Date());
      const slots = await db.select().from(schema.contentItems).where(and(
        eq(schema.contentItems.organisationId, f.organisationId), eq(schema.contentItems.periodKey, periodKey),
      ));
      expect(slots).toHaveLength(2);

      // The writer run goes out under the monthly planner's own key and its
      // one-day window, so a build handed over on the 1st cannot pay twice.
      expect(send).toHaveBeenCalledWith(
        "content.draft",
        { organisationId: f.organisationId, clientId: f.clientId, periodKey, trigger: "event" },
        { singletonKey: `content-draft:${f.clientId}:${periodKey}`, singletonSeconds: 86_400 },
      );
    });
  });

  it("countersigns once, however many times the event arrives", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await signOff(db, f.organisationId, f.project.id);
      const { boss } = fakeBoss();
      const job = { organisationId: f.organisationId, projectId: f.project.id };

      const first = await handleDeliveryFollowOn({ db, boss, env: ENV, logger: quiet }, job);
      const second = await handleDeliveryFollowOn({ db, boss, env: ENV, logger: quiet }, job);

      expect(first.countersignSkipped).toBeNull();
      expect(second).toMatchObject({ countersignedDocumentId: null, countersignSkipped: "already" });
      // No second set of tasks and no second month of slots either: every step
      // in the job claims its own row.
      expect(second.recurringTasksCreated).toBe(0);
      expect(second.contentSlotsCreated).toBe(0);
      const documents = await db.select().from(schema.documents).where(and(
        eq(schema.documents.organisationId, f.organisationId), eq(schema.documents.kind, "delivery_report"),
      ));
      expect(documents).toHaveLength(2);
    });
  });

  it("starts the care plan for a project Shoji closed by hand, with nothing to countersign", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const { boss } = fakeBoss();

      const result = await handleDeliveryFollowOn({ db, boss, env: ENV, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id,
      });

      expect(result).toMatchObject({ countersignSkipped: "not_signed_off", countersignedDocumentId: null });
      // The half that matters to the client still happened.
      expect(result.recurringTasksCreated).toBe(2);
      expect(result.contentSlotsCreated).toBe(2);
    });
  });

  it("does not owe content to a build handed over without a retainer", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, { withSubscription: false });
      await signOff(db, f.organisationId, f.project.id);
      const { boss, send } = fakeBoss();

      const result = await handleDeliveryFollowOn({ db, boss, env: ENV, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id,
      });

      expect(result).toMatchObject({ contentSkipped: "no_active_subscription", contentSlotsCreated: 0, writerQueued: false });
      expect(send).not.toHaveBeenCalled();
      // The countersigned copy and the recurring tasks are not conditional on
      // a content quota.
      expect(result.countersignedDocumentId).not.toBeNull();
      expect(result.recurringTasksCreated).toBe(2);
    });
  });
});
