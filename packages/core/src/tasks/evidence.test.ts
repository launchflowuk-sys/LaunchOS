import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTestDb } from "@launchos/db/test";
import { schema, type Db } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { createTaskTemplate } from "../packages/create-task-template.js";
import { updateTaskTemplate } from "../packages/update-task-template.js";
import { createTask } from "./create-task.js";
import {
  addTaskEvidenceLink, evidenceFromTemplate, evidenceSatisfied, removeTaskEvidence, TaskEvidenceMissing,
  taskEvidenceStatus, tickChecklistItem, uploadTaskAttachment,
} from "./evidence.js";
import { generateOnboardingTasks } from "./generate-onboarding-tasks.js";
import { seedOrgWithClient } from "./test-fixtures.js";
import { updateTaskStatus } from "./update-task-status.js";

let storage: string;
beforeAll(async () => { storage = await mkdtemp(join(tmpdir(), "launchos-evidence-")); });
afterAll(async () => { await rm(storage, { recursive: true, force: true }); });

const rule = { required: true, kinds: ["link", "screenshot", "checklist"] as const, checklist: ["Posted on the Page", "Client tagged"] };

async function taskWithRule(db: Db, organisationId: string, clientId: string, evidence = rule) {
  const template = await createTaskTemplate(db, organisationId, {
    phase: "recurring", kind: "social", title: "Facebook post", recurrence: "monthly",
    evidence: { required: evidence.required, kinds: [...evidence.kinds], checklist: [...evidence.checklist] },
  });
  const task = await createTask(db, organisationId, {
    clientId, templateId: template.id, title: "Facebook post 1/4", kind: "social", phase: "recurring",
    evidence: evidenceFromTemplate(template),
  });
  return { template, task };
}

describe("evidenceSatisfied (pure)", () => {
  it("is satisfied without a rule and names every missing thing with one", () => {
    expect(evidenceSatisfied({ evidence: { links: [], attachments: [], checklist: [] } }, null)).toEqual({ satisfied: true, missing: [] });
    const template = { evidence: { required: true, kinds: ["link", "screenshot", "checklist"] as ("link" | "screenshot" | "checklist")[], checklist: ["A"] } };
    const task = { evidence: { links: [], attachments: [], checklist: [{ item: "A", done: false }] } };
    expect(evidenceSatisfied(task, template).missing).toEqual(["a link to the delivered work", "a screenshot", 'tick "A"']);
    const done = { evidence: { links: ["https://x.test"], attachments: [{ id: "1", name: "s.png", contentType: "image/png", size: 1, url: "/a", uploadedAt: "now" }], checklist: [{ item: "A", done: true }] } };
    expect(evidenceSatisfied(done, template).satisfied).toBe(true);
    expect(evidenceSatisfied(task, { evidence: { required: false, kinds: ["link"], checklist: [] } }).satisfied).toBe(true);
  });
});

describe("task evidence", () => {
  it("copies the template's proof checklist at generation and refuses done until it is met", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      await createTaskTemplate(db, organisationId, {
        phase: "onboarding", kind: "build", title: "Build the site", evidence: { required: true, kinds: ["link", "checklist"], checklist: ["Client signed off"] },
      });
      const { created } = await generateOnboardingTasks(db, organisationId, clientId);
      const task = created[0]!;
      expect(task.evidence).toEqual({ links: [], attachments: [], checklist: [{ item: "Client signed off", done: false }] });

      const refusal = await updateTaskStatus(db, organisationId, { taskId: task.id, status: "done", actorId: ownerUserId }).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(TaskEvidenceMissing);
      expect((refusal as TaskEvidenceMissing).missing).toEqual(["a link to the delivered work", 'tick "Client signed off"']);
      expect((refusal as TaskEvidenceMissing).message).toMatch(/cannot be closed yet/);
      const [untouched] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id));
      expect(untouched!.status).toBe("todo");

      await addTaskEvidenceLink(db, organisationId, { taskId: task.id, url: "https://grayscabline.co.uk", actorId: ownerUserId });
      await tickChecklistItem(db, organisationId, { taskId: task.id, index: 0, done: true, actorId: ownerUserId });
      const status = await taskEvidenceStatus(db, organisationId, task.id);
      expect(status.satisfied).toBe(true);
      expect(status.evidence.checklist[0]).toMatchObject({ done: true, doneBy: ownerUserId });
      expect(typeof status.evidence.checklist[0]!.doneAt).toBe("string");

      const { task: done } = await updateTaskStatus(db, organisationId, { taskId: task.id, status: "done", actorId: ownerUserId });
      expect(done.status).toBe("done");
      // Re-saving a done task as done does not re-check.
      await updateTaskStatus(db, organisationId, { taskId: task.id, status: "done", actorId: ownerUserId });
    });
  });

  it("stores a screenshot under STORAGE_DIR the way inbound attachments are stored, and removes evidence", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      const { task } = await taskWithRule(db, organisationId, clientId);
      const env = { STORAGE_DIR: storage } as NodeJS.ProcessEnv;
      const png = Buffer.from("not really a png").toString("base64");
      const { task: withShot, attachment } = await uploadTaskAttachment(db, organisationId, {
        taskId: task.id, name: "../proof.PNG", contentType: "image/png", contentBase64: png, actorId: ownerUserId,
      }, env);
      expect(attachment.url).toMatch(new RegExp(`^/api/attachments/${organisationId}/[0-9a-f-]{36}\\.png$`));
      expect(attachment.name).toBe("proof.PNG");
      expect(attachment.uploadedBy).toBe(ownerUserId);
      expect(withShot.evidence.attachments).toHaveLength(1);
      const file = attachment.url.split("/").pop()!;
      expect((await readFile(join(storage, "attachments", organisationId, file))).toString()).toBe("not really a png");

      await addTaskEvidenceLink(db, organisationId, { taskId: task.id, url: "https://facebook.com/p/1" });
      const same = await addTaskEvidenceLink(db, organisationId, { taskId: task.id, url: "https://facebook.com/p/1" });
      expect(same.evidence.links).toEqual(["https://facebook.com/p/1"]);

      const noLink = await removeTaskEvidence(db, organisationId, { taskId: task.id, url: "https://facebook.com/p/1" });
      expect(noLink.evidence.links).toEqual([]);
      const noShot = await removeTaskEvidence(db, organisationId, { taskId: task.id, attachmentId: attachment.id });
      expect(noShot.evidence.attachments).toEqual([]);

      const audits = await db.select().from(schema.auditLog).where(and(eq(schema.auditLog.organisationId, organisationId), eq(schema.auditLog.targetId, task.id)));
      expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["task.evidence_added", "task.evidence_removed"]));
    });
  });

  it("unticking clears who and when, and the index is bounded", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId, ownerUserId } = await seedOrgWithClient(db);
      const { task } = await taskWithRule(db, organisationId, clientId);
      const ticked = await tickChecklistItem(db, organisationId, { taskId: task.id, index: 1, done: true, actorId: ownerUserId });
      expect(ticked.evidence.checklist[1]!.doneBy).toBe(ownerUserId);
      const unticked = await tickChecklistItem(db, organisationId, { taskId: task.id, index: 1, done: false, actorId: ownerUserId });
      expect(unticked.evidence.checklist[1]).toEqual({ item: "Client tagged", done: false });
      await expect(tickChecklistItem(db, organisationId, { taskId: task.id, index: 5, done: true })).rejects.toThrow(/out of range/);
    });
  });

  it("template evidence is editable and a task without a template closes freely", async () => {
    await withTestDb(async (db) => {
      const { organisationId, clientId } = await seedOrgWithClient(db);
      const { template, task } = await taskWithRule(db, organisationId, clientId);
      const relaxed = await updateTaskTemplate(db, organisationId, { templateId: template.id, evidence: { required: false, kinds: [], checklist: [] } });
      expect(relaxed.evidence).toEqual({ required: false, kinds: [], checklist: [] });
      const { task: done } = await updateTaskStatus(db, organisationId, { taskId: task.id, status: "done" });
      expect(done.status).toBe("done");

      const free = await createTask(db, organisationId, { clientId, title: "Ad hoc", phase: "support" });
      expect(free.evidence).toEqual({ links: [], attachments: [], checklist: [] });
      expect((await updateTaskStatus(db, organisationId, { taskId: free.id, status: "done" })).task.status).toBe("done");
    });
  });

  it("never reaches across organisations", async () => {
    await withTestDb(async (db) => {
      const a = await seedOrgWithClient(db);
      const b = await seedOrgWithClient(db);
      const { task } = await taskWithRule(db, a.organisationId, a.clientId);
      await expect(addTaskEvidenceLink(db, b.organisationId, { taskId: task.id, url: "https://x.test" })).rejects.toThrow(/not found in organisation/);
      await expect(tickChecklistItem(db, b.organisationId, { taskId: task.id, index: 0, done: true })).rejects.toThrow(/not found in organisation/);
      await expect(taskEvidenceStatus(db, b.organisationId, task.id)).rejects.toThrow(/not found in organisation/);
    });
  });
});
