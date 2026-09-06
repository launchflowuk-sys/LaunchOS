import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { CASE_STUDY_WRITER_KEY } from "@launchos/agents";
import { MockPdfRenderer, looksLikePng, pdfRenderer } from "@launchos/channels/pdf";
import { createProject, getCaseStudyForProject, readContentAsset, setEnqueue, updateCaseStudy } from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { SCREENSHOTS_TAKEN_AT, WRITER_STARTED_AT, handleProjectDelivered } from "./case-study-launch.js";
import type { BossSender } from "./dispatch-event.js";

setEnqueue(async () => {});

const storage = await mkdtemp(join(tmpdir(), "launchos-case-study-"));
const ENV = {
  STORAGE_DIR: storage,
  APP_URL: "https://os.launchflow.test",
  // Never the real engine in a test: the mock is chosen under NODE_ENV=test
  // anyway, and this makes the intent explicit.
  PDF_RENDERER: "mock",
  NODE_ENV: "test",
} as NodeJS.ProcessEnv;

const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date("2026-09-11T16:00:00Z");

afterAll(async () => {
  await rm(storage, { recursive: true, force: true });
});

function fakeBoss() {
  const send = vi.fn<(queue: string, data: unknown, options?: unknown) => Promise<string>>().mockResolvedValue("job-id");
  return { boss: { send } as unknown as BossSender, send };
}

async function fixture(db: Db, url: string | null = "https://kdlandscapes.test/") {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `cs-${randomUUID()}` }).returning();
  const organisationId = org!.id;
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Shoji", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId, userId: ownerId, role: "owner", status: "active" });
  const [client] = await db.insert(schema.clients).values({
    organisationId, name: "KD Landscapes", slug: `kd-${randomUUID()}`, email: "kelly@kdlandscapes.test",
  }).returning();
  const created = await createProject(db, organisationId, {
    clientId: client!.id, name: "Website for KD Landscapes", status: "active",
    actorKind: "user", actorId: ownerId, now: NOW,
  });
  const study = (await getCaseStudyForProject(db, organisationId, created.project.id))!;
  if (url) {
    await updateCaseStudy(db, organisationId, { caseStudyId: study.id, url, actorKind: "user", actorId: ownerId });
  }
  return { organisationId, ownerId, clientId: client!.id, project: created.project, caseStudyId: study.id };
}

describe("what happens when a build is signed off", () => {
  /**
   * The rule this file exists to hold: **one browser, not two.** The
   * screenshots go through the same process-wide renderer the PDF engine
   * borrows, so `pdfRenderer(ENV)` is the object that took them — and the
   * mock's `captured` list proves it, rather than a comment promising it.
   */
  it("photographs the site with the PDF engine's own renderer, at both sizes, and files them as assets", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const renderer = pdfRenderer(ENV) as MockPdfRenderer;
      const before = renderer.captured.length;
      const { boss, send } = fakeBoss();

      const result = await handleProjectDelivered({ db, boss, env: ENV, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id,
      });
      expect(result.captured).toEqual(["desktop", "mobile"]);

      // The captures went through the shared renderer, not a browser of our own.
      const taken = renderer.captured.slice(before);
      expect(taken.map((shot) => shot.viewport)).toEqual(["desktop", "mobile"]);
      expect(taken.every((shot) => shot.url === "https://kdlandscapes.test/")).toBe(true);

      // Both pictures are on the row, as URLs the marketing page can render.
      const study = (await getCaseStudyForProject(db, f.organisationId, f.project.id))!;
      expect(study.screenshots.desktop).toMatch(/^https:\/\/os\.launchflow\.test\/api\/assets\//);
      expect(study.screenshots.mobile).toMatch(/^https:\/\/os\.launchflow\.test\/api\/assets\//);

      // And they are real PNGs on disk, filed against the client like any
      // other image in LaunchOS.
      const assets = await db.select().from(schema.contentAssets)
        .where(eq(schema.contentAssets.organisationId, f.organisationId));
      expect(assets).toHaveLength(2);
      expect(assets.every((asset) => asset.mime === "image/png" && asset.source === "generated")).toBe(true);
      // Not just a row: the bytes on disk are a PNG a browser would accept.
      const file = await readContentAsset(db, assets[0]!.id, ENV);
      expect(file).not.toBeNull();
      expect(looksLikePng(new Uint8Array(file!.bytes))).toBe(true);

      // The writer is started once, keyed, after the pictures.
      expect(result.writerStarted).toBe(true);
      expect(send).toHaveBeenCalledWith(
        "agent.run",
        { agentKey: CASE_STUDY_WRITER_KEY, organisationId: f.organisationId, trigger: "event", payload: { caseStudyId: f.caseStudyId } },
        { singletonKey: `case-study-writer:${f.caseStudyId}` },
      );
    });
  });

  it("runs twice without taking a second set of pictures or starting a second run", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const { boss, send } = fakeBoss();
      const job = { organisationId: f.organisationId, projectId: f.project.id };
      await handleProjectDelivered({ db, boss, env: ENV, logger: quiet }, job);
      const again = await handleProjectDelivered({ db, boss, env: ENV, logger: quiet }, job);

      expect(again.screenshotsSkipped).toBe("already");
      expect(again.captured).toEqual([]);
      expect(again.writerStarted).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(await db.select().from(schema.contentAssets).where(eq(schema.contentAssets.organisationId, f.organisationId))).toHaveLength(2);

      const study = (await getCaseStudyForProject(db, f.organisationId, f.project.id))!;
      expect(study.metadata[SCREENSHOTS_TAKEN_AT]).toBeTruthy();
      expect(study.metadata[WRITER_STARTED_AT]).toBeTruthy();
    });
  });

  /**
   * The URL on a case study is a field the *model* can write, so the browser
   * must never be pointed at it unchecked. `isBlockedTarget` is the same guard
   * the uptime probe uses, applied here because Chromium runs without its own
   * sandbox — a screenshot of `169.254.169.254` is a cloud metadata document
   * on the public Work page.
   */
  it("refuses to photograph a private or non-http address, and still writes the story", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, "http://169.254.169.254/latest/meta-data/");
      const renderer = pdfRenderer(ENV) as MockPdfRenderer;
      const before = renderer.captured.length;
      const { boss, send } = fakeBoss();

      const result = await handleProjectDelivered({ db, boss, env: ENV, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id,
      });
      expect(result.screenshotsSkipped).toBe("blocked_url");
      expect(result.captured).toEqual([]);
      expect(renderer.captured.length).toBe(before);
      // The pictures are the nice part, not the necessary part.
      expect(result.writerStarted).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it("writes the story for a build with no public address yet", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db, null);
      const { boss } = fakeBoss();
      const result = await handleProjectDelivered({ db, boss, env: ENV, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id,
      });
      expect(result.screenshotsSkipped).toBe("no_url");
      expect(result.writerStarted).toBe(true);
    });
  });

  it("does nothing at all for a project with no case study attached", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await db.update(schema.caseStudies)
        .set({ deletedAt: new Date() })
        .where(eq(schema.caseStudies.id, f.caseStudyId));
      const { boss, send } = fakeBoss();
      const result = await handleProjectDelivered({ db, boss, env: ENV, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id,
      });
      expect(result).toMatchObject({ caseStudyId: null, writerStarted: false, screenshotsSkipped: "no_case_study" });
      expect(send).not.toHaveBeenCalled();
    });
  });
});
