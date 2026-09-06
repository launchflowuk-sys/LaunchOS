import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { brandSupportAddress } from "../config.js";
import { emit } from "../events/emit.js";
import { PROJECT_MILESTONE_NOTICE_KIND } from "../support/courtesy-notice.js";
import { projectUpdateRecipients } from "./update-approval.js";
import { requireMilestoneOfProject, requireProject } from "./shared.js";

/**
 * "Your booking form now takes a card." — the same day, unasked.
 *
 * **Safe, and deliberately not approval-gated**, for the reason the meeting
 * no-show note is not: it says only what has already happened, in words we
 * wrote, about a milestone Shoji himself ticked. There is no judgement in it
 * to approve. Putting it behind a card would mean the one message a client
 * actually enjoys receiving arrives on Monday because it was ticked on Friday
 * evening, and a queue of "approve this good news" cards is how an approvals
 * page stops being read.
 *
 * The Friday update is the opposite case and is gated, because there a model
 * chooses what to say about a whole week. Here the model is not involved at
 * all: the template below is the entire message.
 *
 * Sent once per milestone. `reachMilestone` is already idempotent through
 * `WHERE reached_at IS NULL`, so one tick emits one event; the stamp on
 * `project_milestones.metadata` is the second belt, for the case where the
 * worker's job is retried after the email was queued but before the job
 * returned.
 */

/** `project_milestones.metadata` — set once the client has been told. */
export const MILESTONE_EMAILED_AT = "clientEmailedAt";

type MessageRow = typeof schema.messages.$inferSelect;

export interface MilestoneNoticeResult {
  /** One queued row per portal address. Empty when it had already been sent. */
  messages: MessageRow[];
  /** Why nothing was sent, when nothing was: `already`, `hidden`, `no_recipient`. */
  skipped: "already" | "hidden" | "no_recipient" | null;
}

/** The body, in Shoji's plain voice. Short on purpose: it is one piece of news. */
export function milestoneNoticeBody(input: {
  projectName: string;
  milestoneTitle: string;
  detail: string | null;
  percent: number;
  progressSentence: string;
}): string {
  const detail = input.detail?.trim() ? `\n\n${input.detail.trim()}` : "";
  return [
    `Good news — ${input.milestoneTitle} is done on ${input.projectName}.${detail}`,
    `That puts us ${input.percent}% of the way through. ${input.progressSentence}`,
    "There is nothing for you to do; this is just so you know where we are. Sign in to your portal any time to see the whole plan.",
  ].join("\n\n");
}

export const QueueMilestoneNoticeInput = z.object({
  projectId: z.string().uuid(),
  milestoneId: z.string().uuid(),
  /** The bar as it stands now, so the note and the portal agree. */
  progressPercent: z.number().int().min(0).max(100),
  progressSentence: z.string().trim().max(300),
  now: z.date().optional(),
});
export type QueueMilestoneNoticeInput = z.input<typeof QueueMilestoneNoticeInput>;

/**
 * Queues the courtesy note for a milestone that has just been reached.
 *
 * Skipped, never thrown, for the three ordinary reasons: it has been sent
 * before, the milestone is an internal one the client cannot see, or the
 * client has no address. None of those is a fault the worker should retry.
 */
export async function queueMilestoneNotice(
  db: Db,
  organisationId: string,
  input: QueueMilestoneNoticeInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MilestoneNoticeResult> {
  const v = QueueMilestoneNoticeInput.parse(input);
  const project = await requireProject(db, organisationId, v.projectId);
  const milestone = await requireMilestoneOfProject(db, organisationId, v.projectId, v.milestoneId);
  // An internal checkpoint is on the project because Shoji needs it, not
  // because the client does. Emailing one is how "Stripe keys rotated" ends up
  // in a plumber's inbox.
  if (!milestone.clientVisible) return { messages: [], skipped: "hidden" };

  const recipients = await projectUpdateRecipients(db, organisationId, project.clientId);
  if (recipients.length === 0) return { messages: [], skipped: "no_recipient" };

  const [identity] = await db
    .select({ address: schema.emailIdentities.address })
    .from(schema.emailIdentities)
    .where(and(eq(schema.emailIdentities.organisationId, organisationId), eq(schema.emailIdentities.clientId, project.clientId)));
  const from = identity?.address ?? brandSupportAddress(env);
  const now = v.now ?? new Date();
  const subject = `${milestone.title} — done`;
  const body = milestoneNoticeBody({
    projectName: project.name,
    milestoneTitle: milestone.title,
    detail: milestone.detail,
    percent: v.progressPercent,
    progressSentence: v.progressSentence,
  });

  const queued = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    // The claim: only one caller can flip `clientEmailedAt` from null, so a
    // retried job finds nothing to do rather than sending a second note.
    const [claimed] = await tx.update(schema.projectMilestones)
      .set({
        metadata: sql`coalesce(${schema.projectMilestones.metadata}, '{}'::jsonb) || ${JSON.stringify({ [MILESTONE_EMAILED_AT]: now.toISOString() })}::jsonb`,
        updatedAt: now,
      })
      .where(and(
        eq(schema.projectMilestones.id, milestone.id),
        eq(schema.projectMilestones.organisationId, organisationId),
        sql`(${schema.projectMilestones.metadata}->>${MILESTONE_EMAILED_AT}) IS NULL`,
      ))
      .returning();
    if (!claimed) return null;

    const [conversation] = await tx.insert(schema.conversations).values({
      organisationId,
      clientId: project.clientId,
      subject,
      channel: "portal",
      status: "closed",
      lastMessageAt: now,
    }).returning();

    const messages: MessageRow[] = [];
    for (const to of recipients) {
      const [message] = await tx.insert(schema.messages).values({
        organisationId,
        conversationId: conversation!.id,
        direction: "outbound",
        authorKind: "system",
        authorId: null,
        body,
        fromEmail: from,
        toEmail: to,
        subject,
        status: "queued",
        metadata: {
          kind: PROJECT_MILESTONE_NOTICE_KIND,
          projectId: project.id,
          milestoneId: milestone.id,
          progressPercent: v.progressPercent,
        },
      }).returning();
      await recordAudit(tx, organisationId, {
        actorKind: "system", action: "message.queued", targetType: "message", targetId: message!.id, after: message,
      });
      messages.push(message!);
    }
    return messages;
  });

  if (!queued) return { messages: [], skipped: "already" };
  for (const message of queued) {
    await emit({ name: "message.queued", organisationId, messageId: message.id });
  }
  return { messages: queued, skipped: null };
}
