import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { getCaseStudyForProject } from "../case-studies/shared.js";
import { setEnqueue, type DomainEvent } from "../events/emit.js";
import { createProposal } from "../proposals/crud.js";
import { createTask } from "../tasks/create-task.js";
import { seedOrgWithClient } from "../tasks/test-fixtures.js";
import { createProject, listProjects, updateProject } from "./crud.js";
import { deliverProject } from "./deliver.js";
import { UNPHASED, getProject } from "./get-project.js";
import { addMilestone, reachMilestone, updateMilestone } from "./milestones.js";
import { setPhaseStatus } from "./phases.js";
import { ProjectRefused, STANDARD_PHASES, getProjectForProposal } from "./shared.js";

const NOW = new Date("2026-09-07T10:00:00Z");

/** Whatever `core` emitted while the callback ran. */
function catchEvents() {
  const events: DomainEvent[] = [];
  setEnqueue(async (event) => {
    events.push(event);
  });
  return events;
}

async function proposalFixture(db: Db) {
  const seeded = await seedOrgWithClient(db);
  const detail = await createProposal(db, seeded.organisationId, {
    clientId: seeded.clientId,
    title: "Website and booking engine",
    summary: "A new site with online booking.",
    scope: {
      deliverables: ["A thirty-page website", "A four-step booking engine", "Card payment"],
      outOfScope: ["Printed material"],
      timeline: "Six weeks",
    },
    pricing: { shape: "monthly_on_delivery", vatNote: "" },
    lines: [{ kind: "monthly", description: "Care plan", unitPence: 25_000 }],
    actorKind: "user",
    actorId: seeded.ownerUserId,
    now: NOW,
  });
  return { ...seeded, proposalId: detail.proposal.id, reference: detail.proposal.reference };
}

describe("projects", () => {
  it("builds a project from an accepted proposal, with the spine and one milestone per deliverable", async () => {
    await withTestDb(async (db) => {
      catchEvents();
      const { organisationId, ownerUserId, clientId, proposalId, reference } = await proposalFixture(db);
      const result = await createProject(db, organisationId, {
        proposalId, status: "active", actorKind: "user", actorId: ownerUserId, now: NOW,
      });

      expect(result.project.name).toBe("Website and booking engine");
      expect(result.project.summary).toBe("A new site with online booking.");
      expect(result.project.clientId).toBe(clientId);
      expect(result.project.startedAt?.toISOString()).toBe(NOW.toISOString());
      expect(result.phases.map((phase) => phase.key)).toEqual(STANDARD_PHASES.map((phase) => phase.key));
      expect(result.milestones.map((milestone) => milestone.title)).toEqual([
        "A thirty-page website", "A four-step booking engine", "Card payment",
      ]);
      // Deliverables are things we build, so they hang off the build phase.
      const build = result.phases.find((phase) => phase.key === "build")!;
      expect(result.milestones.every((milestone) => milestone.phaseId === build.id)).toBe(true);
      expect(result.caseStudyId).not.toBeNull();

      const study = await getCaseStudyForProject(db, organisationId, result.project.id);
      expect(study!.status).toBe("draft");
      expect(study!.clientId).toBe(clientId);

      // The proposal owns exactly one project, and a second attempt is refused
      // rather than duplicated — the worker's retry is meant to see this.
      expect((await getProjectForProposal(db, organisationId, proposalId))!.id).toBe(result.project.id);
      await expect(createProject(db, organisationId, { proposalId, actorKind: "user", actorId: ownerUserId }))
        .rejects.toThrow(new RegExp(`${reference} already has a project`));

      const audits = await db.select().from(schema.auditLog)
        .where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.action, "project.created")));
      expect(audits).toHaveLength(1);
      const timeline = await db.select().from(schema.activityEvents)
        .where(and(eq(schema.activityEvents.organisationId, organisationId), eq(schema.activityEvents.kind, "project.created")));
      expect(timeline[0]!.title).toBe("Project started: Website and booking engine");
    });
  });

  it("takes explicit fields over the proposal's, and refuses a project with no client", async () => {
    await withTestDb(async (db) => {
      catchEvents();
      const { organisationId, ownerUserId, clientId, proposalId } = await proposalFixture(db);
      const result = await createProject(db, organisationId, {
        proposalId, clientId, name: "Phase two", summary: "Just the booking engine.",
        milestones: [{ title: "Booking engine live" }],
        phases: [{ key: "build" }, { key: "launch" }],
        targetDate: "2026-10-31",
        actorKind: "user", actorId: ownerUserId, now: NOW,
      });
      expect(result.project.name).toBe("Phase two");
      expect(result.project.targetDate).toBe("2026-10-31");
      expect(result.phases.map((phase) => phase.name)).toEqual(["Build", "Launch"]);
      expect(result.milestones).toHaveLength(1);
      expect(result.project.startedAt).toBeNull();

      await expect(createProject(db, organisationId, { name: "Orphan", actorKind: "user", actorId: ownerUserId }))
        .rejects.toThrow(ProjectRefused);
    });
  });

  it("returns the spine, the milestones and the task counts in a fixed number of reads", async () => {
    await withTestDb(async (db) => {
      catchEvents();
      const { organisationId, ownerUserId, clientId } = await seedOrgWithClient(db);
      const created = await createProject(db, organisationId, {
        clientId, name: "Website build", status: "active",
        milestones: [{ title: "Design signed off", phaseKey: "design" }, { title: "Live" , phaseKey: "launch" }],
        actorKind: "user", actorId: ownerUserId, now: NOW,
      });
      const design = created.phases.find((phase) => phase.key === "design")!;
      const build = created.phases.find((phase) => phase.key === "build")!;

      for (const [title, phaseId, status] of [
        ["Wireframes", design.id, "done"],
        ["Home page design", design.id, "in_progress"],
        ["Build the booking form", build.id, "done"],
        ["Abandoned idea", build.id, "cancelled"],
        ["No phase yet", null, "todo"],
      ] as const) {
        const task = await createTask(db, organisationId, {
          clientId, title, phase: "onboarding", kind: "build", actorKind: "user", actorId: ownerUserId,
        });
        await db.update(schema.tasks)
          .set({ projectId: created.project.id, phaseId, status })
          .where(eq(schema.tasks.id, task.id));
      }

      // A Proxy over the db counts how many statements the read issues. Six
      // phases must not mean six queries: the shape this test defends is one
      // read per collection, never one per row.
      let selects = 0;
      const counting = new Proxy(db as object, {
        get(target, property, receiver) {
          if (property === "select") selects += 1;
          return Reflect.get(target, property, receiver);
        },
      }) as Db;

      const detail = (await getProject(counting, organisationId, created.project.id))!;
      expect(selects).toBe(4);

      expect(detail.phases).toHaveLength(6);
      expect(detail.milestones.map((milestone) => milestone.title)).toEqual(["Design signed off", "Live"]);
      // The cancelled task is in neither total: it was called off, not owed.
      expect(detail.tasks).toEqual({ total: 4, done: 2, open: 2 });
      expect(detail.tasksByPhase[design.id]).toEqual({ total: 2, done: 1, open: 1 });
      expect(detail.tasksByPhase[build.id]).toEqual({ total: 1, done: 1, open: 0 });
      expect(detail.tasksByPhase[UNPHASED]).toEqual({ total: 1, done: 0, open: 1 });
      expect(detail.progress.percent).toBe(0);
      expect(detail.progress.unitsTotal).toBe(8);
    });
  });

  it("moves the spine, keeps started_at and clears done_at when a phase is reopened", async () => {
    await withTestDb(async (db) => {
      catchEvents();
      const { organisationId, ownerUserId, clientId } = await seedOrgWithClient(db);
      const created = await createProject(db, organisationId, { clientId, name: "Website build", actorKind: "user", actorId: ownerUserId, now: NOW });
      const design = created.phases.find((phase) => phase.key === "design")!;

      const active = await setPhaseStatus(db, organisationId, { projectId: created.project.id, phaseId: design.id, status: "active", actorKind: "user", actorId: ownerUserId, now: NOW });
      expect(active.startedAt?.toISOString()).toBe(NOW.toISOString());
      expect(active.doneAt).toBeNull();

      const later = new Date("2026-09-20T09:00:00Z");
      const done = await setPhaseStatus(db, organisationId, { projectId: created.project.id, phaseId: design.id, status: "done", actorKind: "user", actorId: ownerUserId, now: later });
      expect(done.doneAt?.toISOString()).toBe(later.toISOString());
      expect(done.startedAt?.toISOString()).toBe(NOW.toISOString());

      const reopened = await setPhaseStatus(db, organisationId, { projectId: created.project.id, phaseId: design.id, status: "active", actorKind: "user", actorId: ownerUserId });
      expect(reopened.doneAt).toBeNull();
      expect(reopened.startedAt?.toISOString()).toBe(NOW.toISOString());

      const skipped = await setPhaseStatus(db, organisationId, { projectId: created.project.id, phaseId: design.id, status: "skipped", actorKind: "user", actorId: ownerUserId });
      const detail = (await getProject(db, organisationId, created.project.id))!;
      expect(skipped.status).toBe("skipped");
      expect(detail.progress.phasesCounted).toBe(5);

      const timeline = await db.select().from(schema.activityEvents)
        .where(and(eq(schema.activityEvents.organisationId, organisationId), eq(schema.activityEvents.kind, "project.phase_done")));
      expect(timeline).toHaveLength(1);
      expect(timeline[0]!.title).toBe("Design finished on Website build");
    });
  });

  it("records a milestone as reached once, and emits once", async () => {
    await withTestDb(async (db) => {
      const events = catchEvents();
      const { organisationId, ownerUserId, clientId } = await seedOrgWithClient(db);
      const created = await createProject(db, organisationId, { clientId, name: "Website build", actorKind: "user", actorId: ownerUserId, now: NOW });
      const milestone = await addMilestone(db, organisationId, {
        projectId: created.project.id, title: "The booking form takes a card",
        detail: "Live payments switched on.", targetDate: "2026-10-01", actorKind: "user", actorId: ownerUserId,
      });
      expect(milestone.clientVisible).toBe(true);

      const renamed = await updateMilestone(db, organisationId, {
        projectId: created.project.id, milestoneId: milestone.id, title: "The booking form takes a card payment",
        clientVisible: false, actorKind: "user", actorId: ownerUserId,
      });
      expect(renamed.title).toBe("The booking form takes a card payment");
      expect(renamed.reachedAt).toBeNull();

      const first = await reachMilestone(db, organisationId, { projectId: created.project.id, milestoneId: milestone.id, reachedAt: NOW, actorKind: "user", actorId: ownerUserId });
      const second = await reachMilestone(db, organisationId, { projectId: created.project.id, milestoneId: milestone.id, reachedAt: new Date(), actorKind: "user", actorId: ownerUserId });
      expect(first.recorded).toBe(true);
      expect(second.recorded).toBe(false);
      expect(second.milestone.reachedAt?.toISOString()).toBe(NOW.toISOString());

      expect(events.filter((event) => event.name === "project.milestone_reached")).toHaveLength(1);
      const timeline = await db.select().from(schema.activityEvents)
        .where(and(eq(schema.activityEvents.organisationId, organisationId), eq(schema.activityEvents.kind, "project.milestone_reached")));
      expect(timeline).toHaveLength(1);
    });
  });

  it("delivers once, leaves the outstanding work standing, and only then reads 100%", async () => {
    await withTestDb(async (db) => {
      const events = catchEvents();
      const { organisationId, ownerUserId, clientId } = await seedOrgWithClient(db);
      const created = await createProject(db, organisationId, {
        clientId, name: "Website build", status: "active",
        milestones: [{ title: "Live" }, { title: "First month of care" }],
        actorKind: "user", actorId: ownerUserId, now: NOW,
      });
      for (const phase of created.phases.filter((row) => row.key !== "care")) {
        await setPhaseStatus(db, organisationId, { projectId: created.project.id, phaseId: phase.id, status: "done", actorKind: "user", actorId: ownerUserId });
      }
      await reachMilestone(db, organisationId, { projectId: created.project.id, milestoneId: created.milestones[0]!.id, actorKind: "user", actorId: ownerUserId });

      const before = (await getProject(db, organisationId, created.project.id))!;
      expect(before.progress.percent).toBe(75);

      const delivered = await deliverProject(db, organisationId, { projectId: created.project.id, deliveredAt: NOW, note: "Handed over.", actorKind: "user", actorId: ownerUserId });
      expect(delivered.project.status).toBe("delivered");
      expect(delivered.caseStudyId).not.toBeNull();
      await expect(deliverProject(db, organisationId, { projectId: created.project.id, actorKind: "user", actorId: ownerUserId }))
        .rejects.toThrow(ProjectRefused);

      const after = (await getProject(db, organisationId, created.project.id))!;
      expect(after.progress.percent).toBe(100);
      // The care phase and its milestone are still open, and still say so.
      expect(after.phases.find((phase) => phase.key === "care")!.status).toBe("pending");
      expect(after.milestones.filter((milestone) => milestone.reachedAt === null)).toHaveLength(1);

      const study = await getCaseStudyForProject(db, organisationId, created.project.id);
      expect(study!.deliveryStatus).toBe("live");
      // Delivery makes the story writable, not public.
      expect(study!.status).toBe("draft");
      expect(events.filter((event) => event.name === "project.delivered")).toHaveLength(1);
    });
  });

  it("refuses to read or write another organisation's project", async () => {
    await withTestDb(async (db) => {
      catchEvents();
      const mine = await seedOrgWithClient(db);
      const theirs = await seedOrgWithClient(db);
      const created = await createProject(db, mine.organisationId, {
        clientId: mine.clientId, name: "Ours", milestones: [{ title: "Live" }],
        actorKind: "user", actorId: mine.ownerUserId, now: NOW,
      });
      const phase = created.phases[0]!;
      const milestone = created.milestones[0]!;

      expect(await getProject(db, theirs.organisationId, created.project.id)).toBeNull();
      expect(await listProjects(db, theirs.organisationId, { limit: 10 })).toHaveLength(0);
      expect(await getProjectForProposal(db, theirs.organisationId, created.project.id)).toBeNull();
      await expect(updateProject(db, theirs.organisationId, { projectId: created.project.id, name: "Stolen", actorKind: "user" })).rejects.toThrow(ProjectRefused);
      await expect(setPhaseStatus(db, theirs.organisationId, { projectId: created.project.id, phaseId: phase.id, status: "done", actorKind: "user" })).rejects.toThrow(ProjectRefused);
      await expect(addMilestone(db, theirs.organisationId, { projectId: created.project.id, title: "Theirs", actorKind: "user" })).rejects.toThrow(ProjectRefused);
      await expect(updateMilestone(db, theirs.organisationId, { projectId: created.project.id, milestoneId: milestone.id, title: "Theirs", actorKind: "user" })).rejects.toThrow(ProjectRefused);
      await expect(reachMilestone(db, theirs.organisationId, { projectId: created.project.id, milestoneId: milestone.id, actorKind: "user" })).rejects.toThrow(ProjectRefused);
      await expect(deliverProject(db, theirs.organisationId, { projectId: created.project.id, actorKind: "user" })).rejects.toThrow(ProjectRefused);
      await expect(createProject(db, theirs.organisationId, { clientId: mine.clientId, name: "Theirs", actorKind: "user" })).rejects.toThrow(/not found in organisation/);

      const still = (await getProject(db, mine.organisationId, created.project.id))!;
      expect(still.project.name).toBe("Ours");
      expect(still.project.deliveredAt).toBeNull();
      expect(still.milestones[0]!.reachedAt).toBeNull();
    });
  });
});
