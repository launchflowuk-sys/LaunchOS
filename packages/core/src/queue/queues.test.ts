import { describe, expect, it } from "vitest";
import {
  DEDUPE_WINDOW_SECONDS,
  JOB_RETRY,
  QUEUE,
  QUEUE_POLICY,
  QUEUE_SPECS,
  dailyDedupe,
  ensureQueues,
  queueSettings,
  type QueueAdmin,
  type QueueSettings,
} from "./queues.js";

function recordingAdmin() {
  const created: QueueSettings[] = [];
  const updated: QueueSettings[] = [];
  const admin: QueueAdmin = {
    async createQueue(name, options) {
      created.push({ ...options, name });
    },
    async updateQueue(name, options) {
      updated.push({ ...options, name });
    },
  };
  return { admin, created, updated };
}

describe("queue topology", () => {
  it("gives every queue name a policy", () => {
    for (const name of Object.values(QUEUE)) {
      expect(QUEUE_POLICY[name]).toBeDefined();
    }
    expect(QUEUE_SPECS).toHaveLength(Object.values(QUEUE).length);
  });

  it("leaves domain.event on standard because its sends carry no singletonKey", () => {
    // Any singleton policy keys on COALESCE(singleton_key, ''), so a keyless
    // queue would collapse every unrelated event into a single job.
    expect(QUEUE_POLICY[QUEUE.domainEvent]).toBe("standard");
  });

  it("puts every keyed queue on `short`, never on `stately`", () => {
    // `stately`'s index is (name, state, key) over created/retry/active, so a
    // duplicate sent while the first job is active inserts legally and then
    // violates the index when pg-boss promotes it — aborting the fetch and
    // stalling the whole queue. `short` covers only `created`, which is the
    // guarantee these queues actually want.
    for (const name of [
      QUEUE.agentRun, QUEUE.agentResume, QUEUE.inboundMessage, QUEUE.outboundMessage,
      QUEUE.tasksGenerateOnboarding, QUEUE.paymentsWebhook,
    ]) {
      expect(QUEUE_POLICY[name]).toBe("short");
    }
    expect(Object.values(QUEUE_POLICY)).not.toContain("stately");
  });

  it("creates and then converges the policy and retry settings of every queue", async () => {
    const { admin, created, updated } = recordingAdmin();

    await ensureQueues(admin);

    // createQueue is ON CONFLICT DO NOTHING in pg-boss, so the update is what
    // fixes a queue an earlier deploy created without these settings.
    expect(created).toEqual(QUEUE_SPECS.map(queueSettings));
    expect(updated).toEqual(created);
    // Retry lives on the queue, not on the sending process's constructor, so
    // web-sent and worker-sent jobs get the same number of attempts.
    for (const settings of created) {
      expect(settings.retryLimit).toBe(JOB_RETRY.retryLimit);
      expect(settings.retryBackoff).toBe(JOB_RETRY.retryBackoff);
    }
  });

  it("pairs a daily dedupe key with a singleton window", () => {
    expect(dailyDedupe("ad-sentinel:org-1:2026-09-04")).toEqual({
      singletonKey: "ad-sentinel:org-1:2026-09-04",
      singletonSeconds: DEDUPE_WINDOW_SECONDS,
    });
  });
});
