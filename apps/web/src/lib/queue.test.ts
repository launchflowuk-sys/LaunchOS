import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@launchos/core";

const send = vi.fn(async () => "job-id");
const createQueue = vi.fn(async () => undefined);
const start = vi.fn(async () => undefined);

vi.mock("pg-boss", () => ({
  default: vi.fn().mockImplementation(() => ({ on: vi.fn(), start, createQueue, send })),
}));

let captured: ((event: DomainEvent) => Promise<void>) | undefined;
vi.mock("@launchos/core", () => ({
  setEnqueue: (fn: (event: DomainEvent) => Promise<void>) => {
    captured = fn;
  },
}));

import { installWebEnqueue } from "./queue.js";

describe("installWebEnqueue", () => {
  beforeEach(() => {
    send.mockClear();
    process.env.DATABASE_URL = "postgres://test/db";
    installWebEnqueue();
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
