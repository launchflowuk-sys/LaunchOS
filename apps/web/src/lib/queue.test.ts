import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@launchos/core";
import { QUEUE_SPECS, queueSettings } from "@launchos/core/queue";

const send = vi.fn(async () => "job-id");
const createQueue = vi.fn(async () => undefined);
const updateQueue = vi.fn(async () => undefined);
const start = vi.fn(async () => undefined);

vi.mock("pg-boss", () => ({
  default: vi.fn().mockImplementation(() => ({ on: vi.fn(), start, createQueue, updateQueue, send })),
}));

let captured: ((event: DomainEvent) => Promise<void>) | undefined;
const notifyOwner = vi.fn(async () => null);
vi.mock("@launchos/core", () => ({
  setEnqueue: (fn: (event: DomainEvent) => Promise<void>) => {
    captured = fn;
  },
  notifyOwner: (...args: unknown[]) => notifyOwner(...(args as [])),
}));

import { installWebEnqueue } from "./queue.js";

describe("installWebEnqueue", () => {
  beforeEach(() => {
    send.mockClear();
    process.env.DATABASE_URL = "postgres://test/db";
    installWebEnqueue();
  });

  it("creates every queue with the shared policy and retry settings, so the web process cannot fix a queue on the wrong ones", async () => {
    // pg-boss's create_queue is ON CONFLICT DO NOTHING, so whichever process
    // boots first would otherwise decide the policy for good — hence the
    // update as well, and hence the shared table in @launchos/core/queue.
    // Retry has to be on the queue too: pg-boss otherwise falls back to the
    // *sending* process's constructor default, which would give web-enqueued
    // jobs two attempts and worker-enqueued jobs five.
    await captured!({ name: "client.created", organisationId: "org-1", clientId: "client-1" });

    for (const spec of QUEUE_SPECS) {
      expect(createQueue).toHaveBeenCalledWith(spec.name, queueSettings(spec));
      expect(updateQueue).toHaveBeenCalledWith(spec.name, queueSettings(spec));
    }
  });

  it("routes email.received onto inbound.message keyed by the inbound message id", async () => {
    const inbound = {
      provider: "generic" as const,
      to: ["a@b.com"],
      from: "x@y.com",
      subject: "s",
      text: "t",
      messageId: "<abc@x>",
      references: [],
      attachments: [],
      rawHeaders: {},
    };

    await captured!({ name: "email.received", organisationId: "org-1", inbound });

    expect(send).toHaveBeenCalledWith(
      "inbound.message",
      { organisationId: "org-1", inbound },
      { singletonKey: "inbound:<abc@x>" },
    );
  });

  it("routes message.queued onto outbound.message keyed by the message id", async () => {
    await captured!({ name: "message.queued", organisationId: "org-1", messageId: "msg-1" });

    expect(send).toHaveBeenCalledWith(
      "outbound.message",
      { organisationId: "org-1", messageId: "msg-1" },
      { singletonKey: "outbound:msg-1" },
    );
  });

  it("routes approval.decided onto agent.resume keyed by the approval id", async () => {
    await captured!({
      name: "approval.decided",
      organisationId: "org-1",
      approvalId: "appr-1",
      runId: "run-1",
      decision: "approved",
      note: "looks good",
    });

    expect(send).toHaveBeenCalledWith(
      "agent.resume",
      { organisationId: "org-1", runId: "run-1", approvalId: "appr-1", decision: "approved", note: "looks good" },
      { singletonKey: "resume:appr-1" },
    );
  });

  it("falls back to the generic domain.event queue for events with no specific mapping", async () => {
    await captured!({ name: "client.created", organisationId: "org-1", clientId: "client-1" });

    expect(send).toHaveBeenCalledWith("domain.event", { name: "client.created", organisationId: "org-1", clientId: "client-1" });
  });
});

describe("getBoss failure caching", () => {
  it("does not pin a failed pg-boss start: the next send starts a fresh instance", async () => {
    // A rejected promise is not nullish, so a plain `??=` cache would keep the
    // first boot failure for the life of the process and every webhook,
    // inbound email and approval would fail until a restart.
    vi.resetModules();
    (globalThis as { __launchosBoss?: unknown }).__launchosBoss = undefined;
    process.env.DATABASE_URL = "postgres://test/db";
    start.mockClear();
    start.mockRejectedValueOnce(new Error("boot failed"));
    const { sendJob } = await import("./queue.js");

    await expect(sendJob("domain.event", { a: 1 })).rejects.toThrow("boot failed");
    await expect(sendJob("domain.event", { a: 1 })).resolves.toBe("job-id");
    expect(start).toHaveBeenCalledTimes(2);
  });

  it("logs and does not throw for bus events the queue cannot take, because the write is already committed", async () => {
    // `emit` runs after the core service committed. Throwing here would turn a
    // successful write into an error toast and invite a retry that hits a
    // unique violation or creates a second row; the follow-on work is what was
    // lost, and it has a manual path back.
    vi.resetModules();
    (globalThis as { __launchosBoss?: unknown }).__launchosBoss = undefined;
    delete process.env.DATABASE_URL;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { installWebEnqueue: install } = await import("./queue.js");
    install();

    await expect(captured!({ name: "client.created", organisationId: "org-1", clientId: "client-1" })).resolves
      .toBeUndefined();
    expect(errors.mock.calls.flat().join(" ")).toMatch(/domain event could not be queued/);
    errors.mockRestore();
  });

  it("still throws for a direct sendJob caller, which is how the Stripe route gets its 500", async () => {
    vi.resetModules();
    (globalThis as { __launchosBoss?: unknown }).__launchosBoss = undefined;
    delete process.env.DATABASE_URL;
    const { sendJob } = await import("./queue.js");

    await expect(sendJob("payments.webhook", { a: 1 })).rejects.toThrow(/DATABASE_URL is not set/);
  });
});
