import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { SYSTEM_ERROR_NOTIFICATION_KIND } from "@launchos/core";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { installProcessErrorAlerts, jobErrorSignature, processErrorSignature, reportJobFailure, reportProcessError } from "./error-alerts.js";

async function organisation(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "T", slug: `alerts-${randomUUID()}` }).returning();
  const ownerId = randomUUID();
  await db.insert(schema.user).values({ id: ownerId, name: "Owner", email: `owner-${ownerId}@example.test`, emailVerified: true });
  await db.insert(schema.organisationMembers).values({ organisationId: org!.id, userId: ownerId, role: "owner", status: "active" });
  return { orgId: org!.id, ownerId };
}

function systemErrors(db: Db, orgId: string) {
  return db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.organisationId, orgId), eq(schema.notifications.kind, SYSTEM_ERROR_NOTIFICATION_KIND)));
}

const quiet = { error() {} };

describe("error signatures", () => {
  it("key on the queue or the process event and the error class, never the message", () => {
    expect(jobErrorSignature("content.publish-due", new TypeError("x"))).toBe("content.publish-due:TypeError");
    expect(jobErrorSignature("q", "a string")).toBe("q:Error");
    expect(processErrorSignature("unhandledRejection", new RangeError("y"))).toBe("process.unhandledRejection:RangeError");
  });
});

describe("reportJobFailure", () => {
  it("tells every active organisation's owner once per (queue, error class) per hour, and never throws", async () => {
    await withTestDb(async (db) => {
      const { orgId, ownerId } = await organisation(db);
      const failure = { queue: "content.publish-due", jobId: "job-1", error: new Error("Graph said no"), retryCount: 5, retryLimit: 5 };

      await reportJobFailure({ db, logger: quiet }, failure);
      const [notice] = await systemErrors(db, orgId);
      expect(notice).toMatchObject({ userId: ownerId, title: "Worker error: content.publish-due:Error", link: "/settings/system" });
      expect(notice!.body).toContain("Job job-1 on content.publish-due failed on its last attempt (6 of 6): Graph said no");

      // The same signature again inside the hour: throttled.
      await reportJobFailure({ db, logger: quiet }, { ...failure, jobId: "job-2", error: new Error("different message, same class") });
      expect(await systemErrors(db, orgId)).toHaveLength(1);
      // A different error class on the same queue is a different signature.
      await reportJobFailure({ db, logger: quiet }, { ...failure, error: new TypeError("shape") });
      expect(await systemErrors(db, orgId)).toHaveLength(2);
    });

    const logger = { error: vi.fn() };
    await expect(reportJobFailure(
      { db: { insert: () => { throw new Error("db gone"); } } as never, logger },
      { queue: "q", jobId: "j", error: new Error("x"), retryCount: 0, retryLimit: 0 },
    )).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("reportProcessError", () => {
  it("logs the error and raises a system.error for it, with a non-Error reason handled too", async () => {
    await withTestDb(async (db) => {
      const { orgId } = await organisation(db);
      const logger = { error: vi.fn() };
      await reportProcessError({ db, logger }, "unhandledRejection", new RangeError("out of range"));
      await reportProcessError({ db, logger }, "uncaughtException", "just a string");
      const notices = await systemErrors(db, orgId);
      expect(notices.map((n) => n.title).sort()).toEqual([
        "Worker error: process.uncaughtException:Error", "Worker error: process.unhandledRejection:RangeError",
      ]);
      expect(logger.error).toHaveBeenCalledWith("worker unhandledRejection", expect.any(RangeError));
    });
  });
});

describe("installProcessErrorAlerts", () => {
  it("registers both process handlers and the returned function removes them", () => {
    const before = { rejection: process.listenerCount("unhandledRejection"), exception: process.listenerCount("uncaughtException") };
    const remove = installProcessErrorAlerts({ db: {} as never, logger: quiet, exit: () => undefined });
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection + 1);
    expect(process.listenerCount("uncaughtException")).toBe(before.exception + 1);
    remove();
    expect(process.listenerCount("unhandledRejection")).toBe(before.rejection);
    expect(process.listenerCount("uncaughtException")).toBe(before.exception);
  });
});
