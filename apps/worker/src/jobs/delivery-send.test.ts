import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createProject, renderDeliveryReport, setEnqueue, signOffDelivery } from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { handleDeliverySend } from "./delivery-send.js";

setEnqueue(async () => {});

const storage = await mkdtemp(join(tmpdir(), "launchos-delivery-send-"));
const ENV = {
  STORAGE_DIR: storage,
  APP_URL: "https://os.launchflow.test",
  SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
  PDF_RENDERER: "mock",
  NODE_ENV: "test",
} as NodeJS.ProcessEnv;

const quiet = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = new Date("2026-09-11T16:00:00Z");

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

/** A finished build with somebody to send it to — or, with `withEmail: false`, nobody. */
async function fixture(db: Db, options: { withEmail?: boolean } = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `ds-${randomUUID()}` }).returning();
  const organisationId = org!.id;
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Shoji", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId, userId: ownerId, role: "owner", status: "active" });

  const [client] = await db.insert(schema.clients).values({
    organisationId,
    name: "KD Landscapes",
    slug: `kd-${randomUUID()}`,
    ...(options.withEmail === false ? {} : { email: "kelly@kdlandscapes.test" }),
  }).returning();

  const created = await createProject(db, organisationId, {
    clientId: client!.id, name: "Website for KD Landscapes", status: "active",
    actorKind: "user", actorId: ownerId, now: NOW,
  });
  return { organisationId, ownerId, clientId: client!.id, project: created.project };
}

describe("the handover send", () => {
  it("renders the report, files it against the project and queues one email per address", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);

      const result = await handleDeliverySend({ db, env: ENV, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id, actorId: f.ownerId,
      });

      expect(result).toMatchObject({ sent: true, projectId: f.project.id });
      expect(result.sent && result.recipients).toBeGreaterThan(0);

      // The stored PDF is on the project, and it is the one the job reported.
      const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, f.project.id));
      expect(project!.deliveryReportDocumentId).toBe(result.sent ? result.documentId : null);
      // And the client can be sent somewhere to read and sign it.
      expect(project!.signOffToken).not.toBeNull();
    });
  });

  it("logs and stops when the world changed between the button and the run, rather than retrying six times", async () => {
    await withTestDb(async (db) => {
      // Already signed off: the report is evidence now and core refuses to
      // re-render it. The admin page checks this before it queues, so reaching
      // it here means somebody signed in the seconds between — which is a log
      // line, not a job that fails five more times to say the same thing.
      const f = await fixture(db);
      const rendered = await renderDeliveryReport(db, f.organisationId, { projectId: f.project.id, actorKind: "system" }, undefined, ENV);
      await signOffDelivery(db, f.organisationId, {
        token: rendered.report.project.signOffToken!,
        signedName: "Kelly Dixon",
        signedEmail: "kelly@kdlandscapes.test",
        now: NOW,
      });

      const result = await handleDeliverySend({ db, env: ENV, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id, actorId: f.ownerId,
      });

      expect(result).toMatchObject({ sent: false, projectId: f.project.id, reason: "not_signable" });
      expect(quiet.warn).toHaveBeenCalled();
    });
  });

  it("refuses a client with nowhere to send it, and says which reason it was", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, { withEmail: false });

      const result = await handleDeliverySend({ db, env: ENV, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id, actorId: f.ownerId,
      });

      expect(result).toMatchObject({ sent: false, reason: "no_recipient" });
    });
  });

  it("keeps a project in another organisation invisible", async () => {
    await withTestDb(async (db) => {
      const mine = await fixture(db);
      const theirs = await fixture(db);

      await expect(
        handleDeliverySend({ db, env: ENV, logger: quiet }, {
          organisationId: mine.organisationId, projectId: theirs.project.id, actorId: mine.ownerId,
        }),
      ).resolves.toMatchObject({ sent: false, reason: "not_found" });
    });
  });
});
