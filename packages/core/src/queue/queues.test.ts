import { describe, expect, it } from "vitest";
import {
  DEDUPE_WINDOW_SECONDS,
  QUEUE,
  QUEUE_POLICY,
  QUEUE_SPECS,
  dailyDedupe,
  ensureQueues,
  type QueueAdmin,
  type QueuePolicy,
} from "./queues.js";

function recordingAdmin() {
  const created: { name: string; policy?: QueuePolicy }[] = [];
  const updated: { name: string; policy?: QueuePolicy }[] = [];
  const admin: QueueAdmin = {
    async createQueue(name, options) {
      created.push({ name, ...(options?.policy !== undefined && { policy: options.policy }) });
    },
    async updateQueue(name, options) {
      updated.push({ name, ...(options?.policy !== undefined && { policy: options.policy }) });
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
    // `stately` keys on COALESCE(singleton_key, ''), so a keyless queue would
    // collapse every unrelated event into a single job.
    expect(QUEUE_POLICY[QUEUE.domainEvent]).toBe("standard");
  });

  it("puts every keyed queue on a policy that enforces singletonKey", () => {
    for (const name of [
      QUEUE.agentRun, QUEUE.agentResume, QUEUE.inboundMessage, QUEUE.outboundMessage,
      QUEUE.tasksGenerateOnboarding, QUEUE.paymentsWebhook,
    ]) {
      expect(QUEUE_POLICY[name]).toBe("stately");
    }
  });

  it("creates and then converges the policy of every queue", async () => {
    const { admin, created, updated } = recordingAdmin();

    await ensureQueues(admin);

    // createQueue is ON CONFLICT DO NOTHING in pg-boss, so the update is what
    // fixes a queue an earlier deploy created without a policy.
    expect(created).toEqual(QUEUE_SPECS.map((s) => ({ name: s.name, policy: s.policy })));
    expect(updated).toEqual(created);
  });

  it("pairs a daily dedupe key with a singleton window", () => {
    expect(dailyDedupe("stripe:evt_1")).toEqual({
      singletonKey: "stripe:evt_1",
      singletonSeconds: DEDUPE_WINDOW_SECONDS,
    });
  });
});
