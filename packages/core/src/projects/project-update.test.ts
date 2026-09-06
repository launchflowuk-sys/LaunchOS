import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { decideApproval } from "../approvals/decide-approval.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { PROJECT_MILESTONE_NOTICE_KIND, PROJECT_UPDATE_NOTICE_KIND, isCourtesyNoticeRow } from "../support/courtesy-notice.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { requestClientReview } from "./client-review.js";
import { createProject } from "./crud.js";
import { queueMilestoneNotice } from "./milestone-notice.js";
import { reachMilestone } from "./milestones.js";
import { setPhaseStatus } from "./phases.js";
import { projectWeekActivity, projectsDueAnUpdate } from "./week-activity.js";
import {
  applyProjectUpdateDecision,
  projectUpdatesAwaitingApplication,
  requestProjectUpdateApproval,
} from "./update-approval.js";

const NOW = new Date("2026-09-11T16:00:00Z");
const ENV = { APP_URL: "https://os.launchflow.test", BRAND_SUPPORT_EMAIL: "support@launchflow.test" } as NodeJS.ProcessEnv;

function catchEvents() {
  const events: DomainEvent[] = [];
  setEnqueue(async (event) => { events.push(event); });
  return events;
}

async function fixture(db: Db, options: { portalUser?: boolean } = {}) {
  const seeded = await seedOrgWithClient(db);
  if (options.portalUser !== false) {
    const userId = randomUUID();
    await db.insert(schema.user).values({ id: userId, name: "Kelly", email: `kelly-${userId}@example.test`, emailVerified: true });
    await db.insert(schema.clientUsers).values({ organisationId: seeded.organisationId, clientId: seeded.clientId, userId, status: "active" });
  }
  const created = await createProject(db, seeded.organisationId, {
    clientId: seeded.clientId,
    name: "Website for KD Landscapes",
    status: "active",
    milestones: [
      { title: "The homepage design", clientVisible: true },
      { title: "Stripe keys rotated", clientVisible: false },
    ],
    actorKind: "user",
    actorId: seeded.ownerUserId,
    now: NOW,
  });
  return { ...seeded, ...created };
}

describe("the week the reporter reads", () => {
  it("carries what moved, keeps internal milestones out of it, and counts an open review", async () => {
    await withTestDb(async (db) => {
      catchEvents();
      const f = await fixture(db);
      const design = f.phases.find((phase) => phase.key === "design")!;
      await setPhaseStatus(db, f.organisationId, {
        projectId: f.project.id, phaseId: design.id, status: "done", actorKind: "user", actorId: f.ownerUserId,
      });
      await reachMilestone(db, f.organisationId, {
        projectId: f.project.id, milestoneId: f.milestones[0]!.id, actorKind: "user", actorId: f.ownerUserId,
      });
      // The internal one is reached too — and must not show up.
      await reachMilestone(db, f.organisationId, {
        projectId: f.project.id, milestoneId: f.milestones[1]!.id, actorKind: "user", actorId: f.ownerUserId,
      });
      await requestClientReview(db, f.organisationId, {
        projectId: f.project.id, note: "Have a look at the green.", actorKind: "user", actorId: f.ownerUserId,
      });

      const week = await projectWeekActivity(db, f.organisationId, { projectId: f.project.id, now: NOW });
      expect(week.milestonesReached.map((milestone) => milestone.title)).toEqual(["The homepage design"]);
      expect(week.phases.find((phase) => phase.key === "design")?.finishedThisWeek).toBe(true);
      expect(week.progress.percent).toBeGreaterThan(0);
      expect(week.progressSentence).toMatch(/steps/);
      expect(week.openReviews).toHaveLength(1);
      // Both milestones count towards the bar; only the client-visible one is
      // ever quoted. The filter is here, not in the prompt.
      expect(week.progress.milestonesReached).toBe(2);
    });
  });

  it("offers the active projects that do not already have an update waiting", async () => {
    await withTestDb(async (db) => {
      catchEvents();
      const f = await fixture(db);
      expect((await projectsDueAnUpdate(db, f.organisationId)).map((row) => row.projectId)).toEqual([f.project.id]);

      await requestProjectUpdateApproval(db, f.organisationId, {
        projectId: f.project.id,
        body: "We finished the design this week.",
        periodStart: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
        periodEnd: NOW.toISOString(),
        progressPercent: 20,
        actorKind: "agent",
        actorId: "project-reporter",
      });
      // A project whose last draft is still waiting is skipped: approving two
      // out of order would send last week's news after this week's.
      expect(await projectsDueAnUpdate(db, f.organisationId)).toEqual([]);
    });
  });
});

describe("the project_update card", () => {
  it("parks the whole email, refuses a second, and emails nothing until it is approved", async () => {
    await withTestDb(async (db) => {
      const events = catchEvents();
      const f = await fixture(db);
      const ask = () => requestProjectUpdateApproval(db, f.organisationId, {
        projectId: f.project.id,
        body: "We finished the design this week and start building on Monday.",
        periodStart: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
        periodEnd: NOW.toISOString(),
        progressPercent: 17,
        actorKind: "agent",
        actorId: "project-reporter",
      });
      const { approval, payload } = await ask();
      expect(approval.kind).toBe("project_update");
      expect(payload.body).toMatch(/start building on Monday/);
      expect(payload.progressPercent).toBe(17);
      await expect(ask()).rejects.toMatchObject({ name: "ProjectUpdateRefused", reason: "already_pending" });

      // Nothing has gone out.
      expect(await db.select().from(schema.messages).where(eq(schema.messages.organisationId, f.organisationId))).toHaveLength(0);
      expect(events.filter((event) => event.name === "message.queued")).toHaveLength(0);
    });
  });

  it("sends Shoji's edit rather than the draft, once, and files it as a courtesy notice", async () => {
    await withTestDb(async (db) => {
      const events = catchEvents();
      const f = await fixture(db);
      const { approval } = await requestProjectUpdateApproval(db, f.organisationId, {
        projectId: f.project.id,
        body: "We absolutely smashed it this week!!",
        periodStart: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
        periodEnd: NOW.toISOString(),
        progressPercent: 17,
        actorKind: "agent",
        actorId: "project-reporter",
      });
      await decideApproval(db, f.organisationId, {
        approvalId: approval.id, decision: "approved", decidedByUserId: f.ownerUserId,
      });

      const applied = await applyProjectUpdateDecision(db, f.organisationId, {
        approvalId: approval.id, actorId: f.ownerUserId, body: "Quiet week — the design is signed off and we start building Monday.",
      }, ENV);
      expect(applied.decision).toBe("approved");
      expect(applied.messages).toHaveLength(1);
      expect(applied.messages[0]!.body).toMatch(/Quiet week/);
      expect(applied.messages[0]!.status).toBe("queued");
      // A record of what we told the client, not a turn in a support thread.
      expect(isCourtesyNoticeRow(applied.messages[0]!.metadata)).toBe(true);
      expect(applied.messages[0]!.metadata["kind"]).toBe(PROJECT_UPDATE_NOTICE_KIND);
      expect(events.filter((event) => event.name === "message.queued")).toHaveLength(1);

      // The approval is now the record of what actually went out.
      const [after] = await db.select().from(schema.approvals).where(eq(schema.approvals.id, approval.id));
      expect(after!.payload["body"]).toMatch(/Quiet week/);

      // Applied once. A second call touches nothing.
      const again = await applyProjectUpdateDecision(db, f.organisationId, { approvalId: approval.id, actorId: f.ownerUserId }, ENV);
      expect(again.alreadyApplied).toBe(true);
      expect(await db.select().from(schema.messages).where(eq(schema.messages.organisationId, f.organisationId))).toHaveLength(1);
      expect(await projectUpdatesAwaitingApplication(db, f.organisationId)).toEqual([]);
    });
  });

  it("rejecting sends nothing and leaves the note on the timeline", async () => {
    await withTestDb(async (db) => {
      catchEvents();
      const f = await fixture(db);
      const { approval } = await requestProjectUpdateApproval(db, f.organisationId, {
        projectId: f.project.id, body: "A draft.", periodStart: NOW.toISOString(), periodEnd: NOW.toISOString(),
        progressPercent: 5, actorKind: "agent", actorId: "project-reporter",
      });
      await decideApproval(db, f.organisationId, {
        approvalId: approval.id, decision: "rejected", decidedByUserId: f.ownerUserId, note: "I'll ring them instead.",
      });
      const applied = await applyProjectUpdateDecision(db, f.organisationId, { approvalId: approval.id, actorId: f.ownerUserId }, ENV);
      expect(applied.decision).toBe("rejected");
      expect(applied.messages).toEqual([]);
      const timeline = await db.select().from(schema.activityEvents).where(and(
        eq(schema.activityEvents.organisationId, f.organisationId),
        eq(schema.activityEvents.kind, "project.update_rejected"),
      ));
      expect(timeline).toHaveLength(1);
      expect(timeline[0]!.body).toBe("I'll ring them instead.");
    });
  });

  it("refuses to draft an update for a client with no address at all", async () => {
    await withTestDb(async (db) => {
      catchEvents();
      const f = await fixture(db, { portalUser: false });
      await expect(requestProjectUpdateApproval(db, f.organisationId, {
        projectId: f.project.id, body: "A draft.", periodStart: NOW.toISOString(), periodEnd: NOW.toISOString(),
        progressPercent: 5, actorKind: "agent", actorId: "project-reporter",
      })).rejects.toMatchObject({ name: "ProjectUpdateRefused", reason: "no_recipient" });
    });
  });
});

describe("the milestone courtesy note", () => {
  it("goes out the same day, once, and never for an internal milestone", async () => {
    await withTestDb(async (db) => {
      const events = catchEvents();
      const f = await fixture(db);

      const hidden = await queueMilestoneNotice(db, f.organisationId, {
        projectId: f.project.id, milestoneId: f.milestones[1]!.id, progressPercent: 10, progressSentence: "1 of 6 steps done.",
      }, ENV);
      // "Stripe keys rotated" is a sentence Shoji wrote for Shoji.
      expect(hidden.skipped).toBe("hidden");
      expect(hidden.messages).toEqual([]);

      const sent = await queueMilestoneNotice(db, f.organisationId, {
        projectId: f.project.id, milestoneId: f.milestones[0]!.id, progressPercent: 20, progressSentence: "1 of 6 steps and 1 of 2 milestones done.",
      }, ENV);
      expect(sent.messages).toHaveLength(1);
      expect(sent.messages[0]!.subject).toBe("The homepage design — done");
      expect(sent.messages[0]!.body).toMatch(/20% of the way through/);
      expect(sent.messages[0]!.body).toMatch(/nothing for you to do/i);
      expect(sent.messages[0]!.metadata["kind"]).toBe(PROJECT_MILESTONE_NOTICE_KIND);
      expect(events.filter((event) => event.name === "message.queued")).toHaveLength(1);

      // The stamp, not the event, is what makes a retried job harmless.
      const again = await queueMilestoneNotice(db, f.organisationId, {
        projectId: f.project.id, milestoneId: f.milestones[0]!.id, progressPercent: 20, progressSentence: "…",
      }, ENV);
      expect(again.skipped).toBe("already");
      expect(await db.select().from(schema.messages).where(eq(schema.messages.organisationId, f.organisationId))).toHaveLength(1);
    });
  });

  it("skips a client with nobody to write to rather than throwing", async () => {
    await withTestDb(async (db) => {
      catchEvents();
      const f = await fixture(db, { portalUser: false });
      const result = await queueMilestoneNotice(db, f.organisationId, {
        projectId: f.project.id, milestoneId: f.milestones[0]!.id, progressPercent: 20, progressSentence: "…",
      }, ENV);
      expect(result.skipped).toBe("no_recipient");
    });
  });
});
