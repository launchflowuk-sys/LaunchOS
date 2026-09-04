import { randomUUID } from "node:crypto";
import { OutboundEmailSchema, type EmailAdapter, type OutboundEmail, type SendResult } from "./types.js";

/**
 * Records what it was asked to send instead of talking to a mail server.
 * It deliberately does not touch the database: the caller
 * (`sendQueuedMessage`) owns the `messages.status` transition.
 */
export class MockEmailAdapter implements EmailAdapter {
  readonly name = "mock" as const;
  readonly sent: OutboundEmail[] = [];

  async send(msg: OutboundEmail): Promise<SendResult> {
    const parsed = OutboundEmailSchema.parse(msg);
    this.sent.push(parsed);
    return { providerMessageId: `mock-${randomUUID()}`, acceptedAt: new Date().toISOString() };
  }
}
