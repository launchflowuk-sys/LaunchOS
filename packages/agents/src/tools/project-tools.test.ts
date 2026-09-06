import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createProject,
  deliverProject,
  getCaseStudyForProject,
  reachMilestone,
  setEnqueue,
  setPhaseStatus,
  updateCaseStudy,
} from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { buildContext } from "../kernel/run-loop.js";
import { caseStudyGetMaterial } from "./case-study-get-material.js";
import { caseStudyPublish } from "./case-study-publish.js";
import { caseStudySaveDraft } from "./case-study-save-draft.js";
import { projectGetWeek } from "./project-get-week.js";
import { CASE_STUDY_WRITER_KEY, PROJECT_REPORTER_KEY } from "./project-shared.js";
import { projectUpdateRequestApproval } from "./project-update-request-approval.js";

const quiet = { info() {}, warn() {}, error() {} };
const NOW = new Date("2026-09-11T16:00:00Z");

setEnqueue(async () => {});

async function fixture(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `pr-${randomUUID()}` }).returning();
  const organisationId = org!.id;
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Shoji", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId, userId: ownerId, role: "owner", status: "active" });
  const [client] = await db.insert(schema.clients).values({
    organisationId, name: "KD Landscapes", slug: `kd-${randomUUID()}`, email: "kelly@kdlandscapes.test",
  }).returning();
  const created = await createProject(db, organisationId, {
    clientId: client!.id,
    name: "Website for KD Landscapes",
    summary: "A new site with a quote form.",
    status: "active",
    milestones: [
      { title: "The homepage design", clientVisible: true },
      { title: "Stripe keys rotated", clientVisible: false },
    ],
    actorKind: "user",
    actorId: ownerId,
    now: NOW,
  });
  return { organisationId, ownerId, clientId: client!.id, ...created };
}

async function ctxFor(db: Db, organisationId: string, agentKey: string) {
  const [run] = await db.insert(schema.agentRuns)
    .values({ organisationId, agentKey, trigger: "cron" }).returning();
  const ctx = buildContext(db, organisationId, run!.id, quiet);
  return { ...ctx, now: () => NOW };
}

describe("the Project Reporter's tools", () => {
  it("reads the week from our own rows, and never another tenant's project", async () => {
    await withTestDb(async (db) => {
      const mine = await fixture(db);
      const theirs = await fixture(db);
      const design = mine.phases.find((phase) => phase.key === "design")!;
      await setPhaseStatus(db, mine.organisationId, {
        projectId: mine.project.id, phaseId: design.id, status: "done", actorKind: "user", actorId: mine.ownerId,
      });
      await reachMilestone(db, mine.organisationId, {
        projectId: mine.project.id, milestoneId: mine.milestones[0]!.id, actorKind: "user", actorId: mine.ownerId,
      });

      const ctx = await ctxFor(db, mine.organisationId, PROJECT_REPORTER_KEY);
      const week = await projectGetWeek.execute({ projectId: mine.project.id }, ctx);
      expect(week.milestonesReached.map((milestone) => milestone.title)).toEqual(["The homepage design"]);
      expect(week.progress.percent).toBeGreaterThan(0);

      // A project id from another organisation is not a project here.
      await expect(projectGetWeek.execute({ projectId: theirs.project.id }, ctx))
        .rejects.toMatchObject({ name: "ProjectRefused", reason: "not_found" });
    });
  });

  it("raises the card and queues nothing, and answers a second ask as data rather than throwing", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const ctx = await ctxFor(db, f.organisationId, PROJECT_REPORTER_KEY);
      const input = {
        projectId: f.project.id,
        body: "We finished the design this week and start building on Monday.",
        periodStart: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
        periodEnd: NOW.toISOString(),
        progressPercent: 17,
      };
      const first = await projectUpdateRequestApproval.execute(input, ctx);
      expect(first).toMatchObject({ requested: true });

      // The tool is `safe`: the card *is* the gate, and gating the tool too
      // would be two decisions for one email.
      expect(projectUpdateRequestApproval.risk).toBe("safe");
      const [approval] = await db.select().from(schema.approvals)
        .where(eq(schema.approvals.organisationId, f.organisationId));
      expect(approval!.kind).toBe("project_update");
      // Run-less: nothing to resume, so the web action applies it.
      expect(approval!.runId).toBeNull();
      expect(await db.select().from(schema.messages).where(eq(schema.messages.organisationId, f.organisationId))).toHaveLength(0);

      const second = await projectUpdateRequestApproval.execute(input, ctx);
      expect(second).toMatchObject({ requested: false });
      expect("reason" in second && second.reason).toMatch(/already waiting/i);
    });
  });
});

describe("the Case Study Writer's allow-list", () => {
  /**
   * The point of the whole agent: the boundary is the schema, not the prompt.
   * A model cannot pass a price, a login, a supplier or a staff name because
   * there is no field for one, and `.strict()` turns an attempt into a refused
   * call rather than a silently dropped key.
   */
  it("has no field for anything private, and refuses a call that invents one", () => {
    const shape = caseStudySaveDraft.input;
    const keys = Object.keys((shape as unknown as { shape: Record<string, unknown> }).shape);
    expect(keys.sort()).toEqual(["brief", "caseStudyId", "name", "sector", "stack", "summary", "url", "year"]);
    for (const forbidden of ["price", "pricePence", "budget", "cost", "credentials", "password", "provider", "vendor", "host", "staff", "internalNotes", "screenshots", "status"]) {
      expect(keys).not.toContain(forbidden);
    }

    // A call carrying one is refused by Zod before `execute` is ever reached —
    // which is where the kernel parses it, so the model gets an error back and
    // the field never touches a row.
    const withPrice = caseStudySaveDraft.input.safeParse({
      caseStudyId: randomUUID(),
      name: "KD Landscapes",
      sector: "Landscaping",
      summary: "A new site with a quote form",
      brief: { client: "a", problem: "b", built: "c", results: "d" },
      pricePaid: 120_000,
    });
    expect(withPrice.success).toBe(false);

    // The brief is strict too: four named paragraphs, and nothing beside them.
    const withNote = caseStudySaveDraft.input.safeParse({
      caseStudyId: randomUUID(),
      name: "KD Landscapes",
      sector: "Landscaping",
      summary: "A new site with a quote form",
      brief: { client: "a", problem: "b", built: "c", results: "d", internalNote: "they were slow to pay" },
    });
    expect(withNote.success).toBe(false);
  });

  it("hands the model the brief, the phases and the client-visible milestones only", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const study = (await getCaseStudyForProject(db, f.organisationId, f.project.id))!;
      const ctx = await ctxFor(db, f.organisationId, CASE_STUDY_WRITER_KEY);
      const material = await caseStudyGetMaterial.execute({ caseStudyId: study.id }, ctx);

      expect(material.name).toBe("Website for KD Landscapes");
      expect(material.milestones.map((milestone) => milestone.title)).toEqual(["The homepage design"]);
      expect(material.phases.map((phase) => phase.name)).toEqual(["Brief", "Design", "Build", "Review", "Launch", "Care"]);
      // Names and states only: a phase's dates would let a story say how long
      // the client took to answer.
      expect(Object.keys(material.phases[0]!).sort()).toEqual(["name", "status"]);
      // Nothing anywhere in the object mentions money or a login.
      const serialised = JSON.stringify(material);
      for (const forbidden of ["pence", "price", "invoice", "password", "secret", "stripe"]) {
        expect(serialised.toLowerCase()).not.toContain(forbidden);
      }
    });
  });

  it("saves a draft and cannot publish one: status is not an input", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const study = (await getCaseStudyForProject(db, f.organisationId, f.project.id))!;
      const ctx = await ctxFor(db, f.organisationId, CASE_STUDY_WRITER_KEY);

      const saved = await caseStudySaveDraft.execute({
        caseStudyId: study.id,
        name: "KD Landscapes",
        sector: "Landscaping",
        summary: "A garden firm that can finally show its work",
        brief: {
          client: "Kelly Dyer runs KD Landscapes in Grays.",
          problem: "No website at all, and every enquiry came through Facebook.",
          built: "A six-page site with a gallery and a quote form.",
          results: "Enquiries arrive overnight and land in one inbox.",
        },
        stack: ["Next.js", "Postgres"],
        year: 2026,
        url: "https://kdlandscapes.test/",
      }, ctx);
      expect(saved).toMatchObject({ saved: true, status: "draft" });

      const after = (await getCaseStudyForProject(db, f.organisationId, f.project.id))!;
      expect(after.status).toBe("draft");
      expect(after.brief.results).toMatch(/Enquiries arrive overnight/);
      // Written as the agent, so the audit row says who.
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, study.id));
      expect(audits.some((row) => row.actorKind === "agent" && row.actorId === CASE_STUDY_WRITER_KEY)).toBe(true);
    });
  });

  it("gates publishing on a human, names the card, and puts the whole story on it", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const study = (await getCaseStudyForProject(db, f.organisationId, f.project.id))!;
      const ctx = await ctxFor(db, f.organisationId, CASE_STUDY_WRITER_KEY);

      // This is the one outward-facing tool the P4 agents have.
      expect(caseStudyPublish.risk).toBe("requires_approval");
      expect(caseStudyPublish.approvalKind).toBe("case_study_publish");

      const thin = await caseStudyPublish.describeApproval!({ caseStudyId: study.id }, ctx);
      // A story with an empty brief says so on the card rather than after.
      expect(thin.summary).toMatch(/not ready yet/i);

      await updateCaseStudy(db, f.organisationId, {
        caseStudyId: study.id,
        summary: "A garden firm that can finally show its work",
        brief: {
          client: "Kelly Dyer runs KD Landscapes in Grays.",
          problem: "No website at all.",
          built: "A six-page site with a gallery and a quote form.",
          results: "Enquiries arrive overnight.",
        },
        actorKind: "agent",
        actorId: CASE_STUDY_WRITER_KEY,
      });

      const card = await caseStudyPublish.describeApproval!({ caseStudyId: study.id }, ctx);
      expect(card.title).toMatch(/Publish the story/);
      expect(card.summary).toMatch(/public Work page/);
      expect(card.details!["What we built"]).toMatch(/six-page site/);
      expect(card.summary).not.toMatch(/not ready/i);

      // Executing it — which only happens after Shoji approves and the kernel
      // resumes — is what actually publishes.
      const published = await caseStudyPublish.execute({ caseStudyId: study.id }, { ...ctx, approvedByUserId: f.ownerId });
      expect(published).toMatchObject({ published: true, status: "published" });
      const live = (await getCaseStudyForProject(db, f.organisationId, f.project.id))!;
      expect(live.publishedAt).not.toBeNull();

      // A story that is already live is a no-op, not a failure: an approval
      // card can be applied twice.
      const again = await caseStudyPublish.execute({ caseStudyId: study.id }, ctx);
      expect(again).toMatchObject({ published: false });
    });
  });

  it("will not overwrite a story that is already live", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await deliverProject(db, f.organisationId, { projectId: f.project.id, actorKind: "user", actorId: f.ownerId });
      const study = (await getCaseStudyForProject(db, f.organisationId, f.project.id))!;
      await updateCaseStudy(db, f.organisationId, { caseStudyId: study.id, status: "published", actorKind: "user", actorId: f.ownerId });

      const ctx = await ctxFor(db, f.organisationId, CASE_STUDY_WRITER_KEY);
      const saved = await caseStudySaveDraft.execute({
        caseStudyId: study.id,
        name: "Something else entirely",
        sector: "Landscaping",
        summary: "Rewritten",
        brief: { client: "a", problem: "b", built: "c", results: "d" },
      }, ctx);
      expect(saved).toMatchObject({ saved: false });
      const after = (await getCaseStudyForProject(db, f.organisationId, f.project.id))!;
      expect(after.name).toBe("Website for KD Landscapes");
    });
  });
});
