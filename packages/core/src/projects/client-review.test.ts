import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { setEnqueue } from "../events/emit.js";
import { createTask } from "../tasks/create-task.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { updateTaskStatus } from "../tasks/update-task-status.js";
import { opsMetricsSnapshot } from "../team/ops-metrics.js";
import {
  ClientReviewRefused,
  approveClientReview,
  clientReviewTargetRef,
  commentOnClientReview,
  commentsOf,
  getClientReview,
  listClientReviews,
  requestClientReview,
  staleClientReviews,
  withdrawClientReview,
} from "./client-review.js";
import { createProject } from "./crud.js";
import { deliverProject } from "./deliver.js";
import { getProject } from "./get-project.js";
import { addMilestone, reachMilestone } from "./milestones.js";
import { setPhaseStatus } from "./phases.js";

const NOW = new Date("2026-09-07T10:00:00Z");

setEnqueue(async () => {});

async function projectFixture(db: Db) {
  const seeded = await seedOrgWithClient(db);
  const created = await createProject(db, seeded.organisationId, {
    clientId: seeded.clientId,
    name: "Website for KD Landscapes",
    summary: "A new site with a quote form.",
    status: "active",
    milestones: [
      { title: "The homepage design", clientVisible: true },
      { title: "The quote form takes an enquiry", clientVisible: true },
    ],
    actorKind: "user",
    actorId: seeded.ownerUserId,
    now: NOW,
  });
  return { ...seeded, project: created.project, phases: created.phases, milestones: created.milestones };
}

/** A portal user for the client, so a review has somebody to have been answered by. */
async function portalUser(db: Db, organisationId: string, clientId: string): Promise<string> {
  const userId = randomUUID();
  await db.insert(schema.user).values({ id: userId, name: "Kelly Dyer", email: `kd-${userId}@example.test`, emailVerified: true });
  await db.insert(schema.clientUsers).values({ organisationId, clientId, userId, status: "active" });
  return userId;
}

describe("client reviews", () => {
  /**
   * The requirement this whole module exists for, and the one somebody will
   * accidentally break: **an undecided client review must not stall anything.**
   *
   * So the test drives a real project from active to delivered with a review
   * sitting open and untouched throughout, and asserts every step succeeded —
   * a task completed, a phase moved to done, a milestone reached, the progress
   * bar moved, and the whole thing signed off. If a future change adds "is a
   * review outstanding?" anywhere on those paths, this fails.
   */
  it("never blocks: a task, a phase, a milestone, the progress bar and delivery all move with one open", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, clientId, project, phases, milestones } = await projectFixture(db);
      const design = phases.find((phase) => phase.key === "design")!;

      const { approval } = await requestClientReview(db, organisationId, {
        projectId: project.id,
        milestoneId: milestones[0]!.id,
        note: "Here's the homepage. Anything you'd change?",
        links: ["https://staging.kdlandscapes.test/"],
        actorKind: "user",
        actorId: ownerUserId,
      });
      expect(approval.status).toBe("pending");

      // A task on the project can be finished, through the service, not a
      // hand-written insert: it is the service path a change would break.
      const task = await createTask(db, organisationId, {
        clientId, title: "Cut the homepage", kind: "build", phase: "onboarding",
        actorKind: "user", actorId: ownerUserId,
      });
      await db.update(schema.tasks).set({ projectId: project.id, phaseId: design.id }).where(eq(schema.tasks.id, task.id));
      const finished = await updateTaskStatus(db, organisationId, {
        taskId: task.id, status: "done", actorKind: "user", actorId: ownerUserId,
      });
      expect(finished.task.status).toBe("done");

      // A phase can be moved to done.
      const done = await setPhaseStatus(db, organisationId, {
        projectId: project.id, phaseId: design.id, status: "done", actorKind: "user", actorId: ownerUserId,
      });
      expect(done.status).toBe("done");
      expect(done.doneAt).not.toBeNull();

      // The very milestone the review is *about* can be reached.
      const reached = await reachMilestone(db, organisationId, {
        projectId: project.id, milestoneId: milestones[0]!.id, actorKind: "user", actorId: ownerUserId,
      });
      expect(reached.recorded).toBe(true);

      // The bar moved on the strength of it.
      const detail = (await getProject(db, organisationId, project.id))!;
      expect(detail.progress.percent).toBeGreaterThan(0);
      expect(detail.progress.unitsDone).toBe(2);

      // And the project can be delivered.
      const delivered = await deliverProject(db, organisationId, {
        projectId: project.id, actorKind: "user", actorId: ownerUserId,
      });
      expect(delivered.project.deliveredAt).not.toBeNull();

      // Through all of that the review is exactly where it started.
      const after = (await getClientReview(db, organisationId, approval.id))!;
      expect(after.status).toBe("pending");
      expect(after.decidedAt).toBeNull();
    });
  });

  it("raises the card from our own rows, records it on the client's timeline, and emails nobody", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, clientId, project, milestones } = await projectFixture(db);
      const { approval, payload } = await requestClientReview(db, organisationId, {
        projectId: project.id,
        milestoneId: milestones[0]!.id,
        note: "Have a look at the green.",
        screenshots: ["https://os.test/api/assets/abc"],
        actorKind: "user",
        actorId: ownerUserId,
      });

      expect(approval.kind).toBe("client_review");
      expect(payload.clientName).toBe("Grays CabLine");
      expect(payload.projectName).toBe("Website for KD Landscapes");
      expect(payload.milestoneTitle).toBe("The homepage design");
      expect(payload.targetRef).toBe(clientReviewTargetRef(project.id, milestones[0]!.id));
      expect(payload.screenshots).toEqual(["https://os.test/api/assets/abc"]);

      const timeline = await db.select().from(schema.activityEvents).where(and(
        eq(schema.activityEvents.organisationId, organisationId),
        eq(schema.activityEvents.kind, "project.client_review_requested"),
      ));
      expect(timeline).toHaveLength(1);
      expect(timeline[0]!.clientId).toBe(clientId);

      // Nothing outward. A review that chased the client would be a blocker
      // wearing a different hat.
      const messages = await db.select().from(schema.messages)
        .where(eq(schema.messages.organisationId, organisationId));
      expect(messages).toHaveLength(0);
    });
  });

  it("refuses a second open review for the same milestone, and allows one for another", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, project, milestones } = await projectFixture(db);
      const ask = (milestoneId: string) => requestClientReview(db, organisationId, {
        projectId: project.id, milestoneId, note: "A look, please.", actorKind: "user", actorId: ownerUserId,
      });
      await ask(milestones[0]!.id);
      await expect(ask(milestones[0]!.id)).rejects.toMatchObject({ name: "ClientReviewRefused", reason: "already_open" });
      // A different thing to look at is a different review.
      const second = await ask(milestones[1]!.id);
      expect(second.approval.id).toBeTruthy();
      expect(await listClientReviews(db, organisationId, { projectId: project.id, status: "pending" })).toHaveLength(2);
    });
  });

  it("treats a comment as a message, not a rejection: the card stays open and can still be approved", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, clientId, project, milestones } = await projectFixture(db);
      const userId = await portalUser(db, organisationId, clientId);
      const { approval } = await requestClientReview(db, organisationId, {
        projectId: project.id, milestoneId: milestones[0]!.id, note: "Homepage?", actorKind: "user", actorId: ownerUserId,
      });

      const commented = await commentOnClientReview(db, organisationId, {
        approvalId: approval.id, actorUserId: userId, note: "The green is too dark.",
      });
      // Still pending. A client who asks for a change on Monday may well be
      // happy on Thursday, and `rejected` would leave Thursday nowhere to go.
      expect(commented.approval.status).toBe("pending");
      expect(commented.comments).toHaveLength(1);
      expect(commented.comments[0]!.body).toBe("The green is too dark.");

      // A second comment appends rather than replacing.
      const again = await commentOnClientReview(db, organisationId, {
        approvalId: approval.id, actorUserId: userId, note: "Much better now.",
      });
      expect(again.comments.map((comment) => comment.body)).toEqual(["The green is too dark.", "Much better now."]);

      const approved = await approveClientReview(db, organisationId, { approvalId: approval.id, actorUserId: userId });
      expect(approved.status).toBe("approved");
      expect(approved.decidedBy).toBe(userId);
      expect(commentsOf(approved)).toHaveLength(2);

      // Approving twice is the client tapping twice on a phone, not an error
      // the portal should show as a failure to record their answer.
      await expect(approveClientReview(db, organisationId, { approvalId: approval.id, actorUserId: userId }))
        .rejects.toBeInstanceOf(ClientReviewRefused);
    });
  });

  it("lists an unanswered review in the Ops Brief after five days, but not one being talked about", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, clientId, project, milestones } = await projectFixture(db);
      const userId = await portalUser(db, organisationId, clientId);
      const quiet = await requestClientReview(db, organisationId, {
        projectId: project.id, milestoneId: milestones[0]!.id, note: "Homepage?", actorKind: "user", actorId: ownerUserId,
      });
      const talking = await requestClientReview(db, organisationId, {
        projectId: project.id, milestoneId: milestones[1]!.id, note: "Quote form?", actorKind: "user", actorId: ownerUserId,
      });
      await commentOnClientReview(db, organisationId, {
        approvalId: talking.approval.id, actorUserId: userId, note: "Can we move the button?",
      });
      // Both were raised now; age them by asking from six days ahead.
      const later = new Date(NOW.getTime() + 6 * 24 * 60 * 60 * 1000);
      await db.update(schema.approvals)
        .set({ createdAt: NOW })
        .where(eq(schema.approvals.organisationId, organisationId));

      const stale = await staleClientReviews(db, organisationId, { now: later });
      expect(stale.map((review) => review.approval.id)).toEqual([quiet.approval.id]);
      expect(stale[0]!.daysWaiting).toBe(6);

      // And it is the one line the brief gets out of it.
      const snapshot = await opsMetricsSnapshot(db, organisationId, { now: later, hours: 24 });
      expect(snapshot.projects.clientReviewsUnanswered).toBe(1);
      expect(snapshot.projects.oldestClientReviewDays).toBe(6);
    });
  });

  it("keeps a review to its own organisation, and frees the slot when one is withdrawn", async () => {
    await withTestDb(async (db) => {
      const mine = await projectFixture(db);
      const theirs = await projectFixture(db);
      const { approval } = await requestClientReview(db, mine.organisationId, {
        projectId: mine.project.id, note: "A look, please.", actorKind: "user", actorId: mine.ownerUserId,
      });

      expect(await getClientReview(db, theirs.organisationId, approval.id)).toBeNull();
      expect(await listClientReviews(db, theirs.organisationId, {})).toHaveLength(0);

      await withdrawClientReview(db, mine.organisationId, { approvalId: approval.id, actorId: mine.ownerUserId });
      // Withdrawn, so a fresh one about the same project is allowed again.
      const again = await requestClientReview(db, mine.organisationId, {
        projectId: mine.project.id, note: "Try this one instead.", actorKind: "user", actorId: mine.ownerUserId,
      });
      expect(again.approval.id).not.toBe(approval.id);
    });
  });

  it("counts a milestone added after the review the same as any other", async () => {
    await withTestDb(async (db) => {
      const { organisationId, ownerUserId, project } = await projectFixture(db);
      await requestClientReview(db, organisationId, {
        projectId: project.id, note: "A look at the whole thing.", actorKind: "user", actorId: ownerUserId,
      });
      // Adding work while a review is open is ordinary, not a special case.
      const added = await addMilestone(db, organisationId, {
        projectId: project.id, title: "The gallery loads on a phone", actorKind: "user", actorId: ownerUserId,
      });
      expect(added.reachedAt).toBeNull();
      const detail = (await getProject(db, organisationId, project.id))!;
      expect(detail.milestones).toHaveLength(3);
    });
  });
});
