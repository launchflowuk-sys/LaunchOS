import type { Db } from "@launchos/db";
import type { EmailAdapter } from "@launchos/channels";
import { sendQueuedMessage } from "@launchos/core";

export interface OutboundMessageJob { organisationId: string; messageId: string }
export interface OutboundMessageDeps { db: Db; adapter: EmailAdapter; logger: Console }

export async function handleOutboundMessage(deps: OutboundMessageDeps, job: OutboundMessageJob) {
  const message = await sendQueuedMessage(deps.db, job.organisationId, { messageId: job.messageId }, deps.adapter);
  deps.logger.info({ messageId: message.id, status: message.status, adapter: deps.adapter.name }, "outbound message");
  return message;
}
