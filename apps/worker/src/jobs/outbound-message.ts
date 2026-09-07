import type { Db } from "@launchos/db";
import type { EmailAdapter, SmsAdapter } from "@launchos/channels";
import { sendQueuedMessage } from "@launchos/core";

export interface OutboundMessageJob { organisationId: string; messageId: string }
export interface OutboundMessageDeps {
  db: Db;
  adapter: EmailAdapter;
  /**
   * Only a reply to somebody who left a number needs this. Optional so the job
   * stays constructible without it — `sendQueuedMessage` refuses such a message
   * loudly rather than sending it the wrong way.
   */
  sms?: SmsAdapter;
  logger: Console;
}

export async function handleOutboundMessage(deps: OutboundMessageDeps, job: OutboundMessageJob) {
  const message = await sendQueuedMessage(
    deps.db, job.organisationId, { messageId: job.messageId }, deps.adapter, process.env, deps.sms,
  );
  deps.logger.info(
    { messageId: message.id, status: message.status, channel: message.channel, adapter: message.channel === "email" ? deps.adapter.name : deps.sms?.name },
    "outbound message",
  );
  return message;
}
