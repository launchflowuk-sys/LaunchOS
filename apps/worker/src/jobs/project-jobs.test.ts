import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { CASE_STUDY_WRITER_KEY, PROJECT_REPORTER_KEY } from "@launchos/agents";
import {
  createProject,
  reachMilestone,
  requestProjectUpdateApproval,
  setEnqueue,
  updateProject,
} from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import type { BossRegistrar } from "./content-jobs.js";
import { dispatchEvent } from "./dispatch-event.js";
import { handleMilestoneEmail } from "./project-milestone-email.js";
import { PROJECT_CRON, ensureProjectAgentsEnabled, registerProjectJobs } from "./project-jobs.js";
import { buildWeeklyUpdateJobs, dispatchWeeklyUpdates } from "./project-weekly-update.js";

setEnqueue(async () => {});

process.env["APP_URL"] = "https://os.launchflow.test";

const quiet = { info() {}, warn() {}, error() {} };
const FRIDAY = new Date("2026-09-11T16:00:00Z");

function fakeBoss() {
  const work = vi.fn<(queue: string, handler: unknown) => Promise<string>>().mockResolvedValue("worker-id");
  const schedule = vi.fn<(queue: string, cron: string, data: unknown, options: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const send = vi.fn<(queue: string, data: unknown, options?: unknown) => Promise<string>>().mockResolvedValue("job-id");
  return { boss: { work, schedule, send } as unknown as BossRegistrar, work, schedule, send };
}

async function fixture(db: Db, options: { portalUser?: boolean } = {}) {
  const [org] = await db.insert(schema.organisations).values({ name: "LaunchFlow", slug: `pj-${randomUUID()}` }).returning();
  const organisationId = org!.id;
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Shoji", email: `o-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId, userId: ownerId, role: "owner", status: "active" });
  const [client] = await db.insert(schema.clients).values({
    organisationId, name: "KD Landscapes", slug: `kd-${randomUUID()}`,
    ...(options.portalUser === false ? {} : { email: "kelly@kdlandscapes.test" }),
  }).returning();
  const created = await createProject(db, organisationId, {
    clientId: client!.id,
    name: "Website for KD Landscapes",
    status: "active",
    milestones: [
      { title: "The homepage design", clientVisible: true },
      { title: "Stripe keys rotated", clientVisible: false },
    ],
    actorKind: "user",
    actorId: ownerId,
    now: FRIDAY,
  });
  return { organisationId, ownerId, clientId: client!.id, ...created };
}

describe("the project queues", () => {
  it("registers a worker for each of the four queues and puts the one cron on Friday, London time", async () => {
    await withTestDb(async (db) => {
      const { boss, work, schedule } = fakeBoss();
      await registerProjectJobs({ db, boss, env: process.env, logger: quiet });
      // `delivery.send` sits here rather than with the other delivery work
      // because this is the file that owns a project's queues, and the handover
      // is a project's. A registration missing from this list is a button that
      // queues a job nothing is listening to — which is exactly what the
      // handover was before it was added.
      expect(work.mock.calls.map(([queue]) => queue).sort()).toEqual([
        "delivery.send", "projects.delivered", "projects.milestone-email", "projects.weekly-update",
      ]);
      expect(schedule.mock.calls.map(([queue, cron, , options]) => [queue, cron, options])).toEqual([
        ["projects.weekly-update", "0 16 * * 5", { tz: "Europe/London" }],
      ]);
      // Friday at four: late enough that the week is ticked, early enough that
      // Shoji approves the drafts before he stops.
      expect(PROJECT_CRON["projects.weekly-update"]).toBe("0 16 * * 5");
    });
  });

  it("switches both agents on once, and never overrides a decision already made", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      // Somebody has already turned the writer off; that must stand.
      await db.insert(schema.agentEnablement)
        .values({ organisationId: f.organisationId, agentKey: CASE_STUDY_WRITER_KEY, enabled: false });

      const first = await ensureProjectAgentsEnabled(db, quiet);
      expect(first.enabled).toBeGreaterThan(0);
      const second = await ensureProjectAgentsEnabled(db, quiet);
      expect(second.enabled).toBe(0);

      const rows = await db.select().from(schema.agentEnablement)
        .where(eq(schema.agentEnablement.organisationId, f.organisationId));
      expect(rows.find((row) => row.agentKey === PROJECT_REPORTER_KEY)?.enabled).toBe(true);
      expect(rows.find((row) => row.agentKey === CASE_STUDY_WRITER_KEY)?.enabled).toBe(false);
    });
  });
});

describe("the Friday fan-out", () => {
  it("sends one keyed, day-deduped agent run per active project with nothing already waiting", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await db.insert(schema.agentEnablement)
        .values({ organisationId: f.organisationId, agentKey: PROJECT_REPORTER_KEY, enabled: true });
      // A second build that has not started: nothing to report on yet.
      await createProject(db, f.organisationId, {
        clientId: f.clientId, name: "Later", status: "planned", actorKind: "user", actorId: f.ownerId, now: FRIDAY,
      });

      const { boss, send } = fakeBoss();
      await dispatchWeeklyUpdates({ db, boss, logger: quiet }, FRIDAY);
      const mine = send.mock.calls.filter(([, data]) => (data as { organisationId: string }).organisationId === f.organisationId);
      expect(mine).toHaveLength(1);
      const [queue, data, options] = mine[0]!;
      expect(queue).toBe("agent.run");
      expect(data).toMatchObject({ agentKey: PROJECT_REPORTER_KEY, trigger: "cron", payload: { projectId: f.project.id } });
      // An Opus-priced run: keyed per project per day, and the window fits
      // inside the archive interval (76f313a).
      expect(options).toMatchObject({ singletonKey: `project-reporter:${f.project.id}:2026-09-11`, singletonSeconds: 86_400 });
    });
  });

  it("skips a project whose last draft is still waiting for Shoji", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await db.insert(schema.agentEnablement)
        .values({ organisationId: f.organisationId, agentKey: PROJECT_REPORTER_KEY, enabled: true });
      await requestProjectUpdateApproval(db, f.organisationId, {
        projectId: f.project.id, body: "Last week's draft.", periodStart: FRIDAY.toISOString(), periodEnd: FRIDAY.toISOString(),
        progressPercent: 10, actorKind: "agent", actorId: PROJECT_REPORTER_KEY,
      });
      const jobs = await buildWeeklyUpdateJobs(db);
      expect(jobs.filter((job) => job.organisationId === f.organisationId)).toEqual([]);
    });
  });

  it("skips an organisation that has switched the reporter off", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await db.insert(schema.agentEnablement)
        .values({ organisationId: f.organisationId, agentKey: PROJECT_REPORTER_KEY, enabled: false });
      const jobs = await buildWeeklyUpdateJobs(db);
      expect(jobs.filter((job) => job.organisationId === f.organisationId)).toEqual([]);
    });
  });

  it("says nothing about a build that has been put on hold", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      await db.insert(schema.agentEnablement)
        .values({ organisationId: f.organisationId, agentKey: PROJECT_REPORTER_KEY, enabled: true });
      await updateProject(db, f.organisationId, {
        projectId: f.project.id, status: "on_hold", actorKind: "user", actorId: f.ownerId,
      });
      const jobs = await buildWeeklyUpdateJobs(db);
      expect(jobs.filter((job) => job.organisationId === f.organisationId)).toEqual([]);
    });
  });
});

describe("the milestone note", () => {
  it("routes the domain event to a keyed job, and the job queues one email with the live percentage on it", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const { boss, send } = fakeBoss();
      await dispatchEvent({ db, boss: boss as unknown as Parameters<typeof dispatchEvent>[0]["boss"] }, {
        name: "project.milestone_reached",
        organisationId: f.organisationId,
        projectId: f.project.id,
        milestoneId: f.milestones[0]!.id,
      });
      expect(send).toHaveBeenCalledWith(
        "projects.milestone-email",
        { organisationId: f.organisationId, projectId: f.project.id, milestoneId: f.milestones[0]!.id },
        { singletonKey: `milestone-email:${f.milestones[0]!.id}` },
      );

      await reachMilestone(db, f.organisationId, {
        projectId: f.project.id, milestoneId: f.milestones[0]!.id, actorKind: "user", actorId: f.ownerId,
      });
      const result = await handleMilestoneEmail({ db, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id, milestoneId: f.milestones[0]!.id,
      });
      expect(result.queued).toBe(1);
      // The figure is read at send time, so the email and the portal agree.
      expect(result.messages[0]!.body).toMatch(/of the way through/);
      expect(result.messages[0]!.metadata["progressPercent"]).toBeGreaterThan(0);

      const again = await handleMilestoneEmail({ db, logger: quiet }, {
        organisationId: f.organisationId, projectId: f.project.id, milestoneId: f.milestones[0]!.id,
      });
      expect(again.skipped).toBe("already");
      expect(again.queued).toBe(0);
    });
  });

  it("routes a delivery to its own keyed job", async () => {
    await withTestDb(async (db) => {
      const f = await fixture(db);
      const { boss, send } = fakeBoss();
      await dispatchEvent({ db, boss: boss as unknown as Parameters<typeof dispatchEvent>[0]["boss"] }, {
        name: "project.delivered", organisationId: f.organisationId, projectId: f.project.id,
      });
      expect(send).toHaveBeenCalledWith(
        "projects.delivered",
        { organisationId: f.organisationId, projectId: f.project.id },
        { singletonKey: `project-delivered:${f.project.id}` },
      );
    });
  });
});
