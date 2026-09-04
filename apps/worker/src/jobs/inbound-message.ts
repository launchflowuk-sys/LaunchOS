import type { Db } from "@launchos/db";
import type { InboundEmail } from "@launchos/channels";
import { ingestInboundEmail } from "@launchos/core";

export interface InboundMessageJob { organisationId: string; inbound: InboundEmail }
export interface InboundMessageDeps { db: Db; logger: Console }

/**
 * The webhook only validates, stores attachments and enqueues; every database
 * write for an inbound email happens here, so a provider retry is cheap and a
 * slow database can never time the webhook out.
 */
export async function handleInboundMessage(deps: InboundMessageDeps, job: InboundMessageJob) {
  const result = await ingestInboundEmail(deps.db, job.organisationId, job.inbound);
  deps.logger.info(
    { conversationId: result.conversation.id, ticketId: result.ticket.id, matched: result.matched },
    "inbound email ingested",
  );
  return result;
}
