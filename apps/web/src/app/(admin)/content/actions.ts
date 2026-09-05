"use server";

import {
  cancelContentItem, ContentRefused, planContentMonth, requestContentApproval, updateContentItem,
} from "@launchos/core";
import type { QueueName } from "@launchos/core/queue";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { installWebEnqueue, sendJob } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";
import { londonInputToDate } from "./schedule-input";
import {
  type ActionResult, CancelItemSchema, EditItemSchema, firstIssue, ItemIdSchema, MonthActionSchema,
} from "./schemas";

/**
 * The queue the content writer listens on. Phase C3 owns the queue table in
 * `@launchos/core/queue` and the worker consumer; until that lands the name is
 * not a `QueueName`, so it is declared here and cast at the send. If C3 ships
 * a different name, change this one constant.
 */
const CONTENT_DRAFT_QUEUE = "content.draft" as QueueName;

function value(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : undefined;
}

/** A refusal is a sentence written for the operator; anything else is ours to log. */
function failed(error: unknown, fallback: string): ActionResult {
  if (error instanceof ContentRefused) return { status: "error", message: error.message };
  console.error(fallback, error);
  return { status: "error", message: error instanceof Error ? error.message : fallback };
}

function revalidateItem(itemId: string, clientId: string): void {
  revalidatePath("/content");
  revalidatePath(`/content/${itemId}`);
  revalidatePath(`/clients/${clientId}/content`);
  revalidatePath("/portal/content");
  revalidatePath("/approvals");
  revalidatePath("/");
}

/**
 * "Plan this month" and "Draft with AI" share one form; the button pressed
 * says which. Planning creates the month's empty slots from the package;
 * drafting hands those slots to the content writer in the worker.
 */
export async function contentMonthAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  installWebEnqueue();
  const parsed = MonthActionSchema.safeParse({
    clientId: value(formData, "clientId"),
    periodKey: value(formData, "periodKey"),
    intent: value(formData, "intent"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Choose a client and a month") };
  const { clientId, periodKey, intent } = parsed.data;

  try {
    if (intent === "plan") {
      const result = await planContentMonth(getDb(), session.organisationId, {
        clientId, periodKey, actorKind: "user", actorId: session.userId,
      });
      revalidatePath("/content");
      revalidatePath(`/clients/${clientId}/content`);
      if (result.created === 0 && result.skipped === 0) {
        return {
          status: "error",
          message: "That package has no monthly content in it, so there is nothing to plan.",
        };
      }
      return { status: "ok", id: `${result.created}:${result.skipped}` };
    }

    // A draft run is a real, billed Claude run. The cron send is keyed
    // `content-draft:<clientId>:<periodKey>` under a one-day window, so an
    // operator's "Draft with AI" must not be swallowed as a duplicate of it —
    // the timestamp is deliberate, the same shape as the support-triage "run
    // now". Pressing it twice queues two runs; the writer only fills slots
    // that are still empty drafts, so the second finds nothing to do.
    await sendJob(
      CONTENT_DRAFT_QUEUE,
      { organisationId: session.organisationId, clientId, periodKey },
      { singletonKey: `content-draft:${clientId}:${periodKey}:manual:${Date.now()}` },
    );
    return { status: "ok" };
  } catch (error) {
    if (intent === "draft" && error instanceof Error && /queue.*(does not exist|not found)/i.test(error.message)) {
      return {
        status: "error",
        message:
          "AI drafting is not switched on yet: the worker has no content.draft queue. " +
          "Plan the month and write the posts by hand for now.",
      };
    }
    return failed(error, intent === "plan" ? "Could not plan the month" : "Could not queue the AI draft");
  }
}

/** Save the text, image, link and date. Blank clears; the date is read as London time. */
export async function saveContentItemAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = EditItemSchema.safeParse({
    itemId: value(formData, "itemId"),
    title: value(formData, "title") ?? "",
    body: value(formData, "body") ?? "",
    imageUrl: value(formData, "imageUrl") ?? "",
    linkUrl: value(formData, "linkUrl") ?? "",
    scheduledFor: value(formData, "scheduledFor") ?? "",
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const v = parsed.data;

  const scheduledFor = v.scheduledFor ? londonInputToDate(v.scheduledFor) : null;
  if (scheduledFor === undefined) return { status: "error", message: "Enter a date and time" };

  try {
    const item = await updateContentItem(getDb(), session.organisationId, {
      itemId: v.itemId,
      title: v.title || null,
      body: v.body || null,
      imageUrl: v.imageUrl || null,
      linkUrl: v.linkUrl || null,
      scheduledFor,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateItem(item.id, item.clientId);
    return { status: "ok", id: item.id };
  } catch (error) {
    return failed(error, "Could not save the post");
  }
}

/** Parks the item in Approvals. Approving there is what publishes it. */
export async function requestContentApprovalAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  installWebEnqueue();
  const parsed = ItemIdSchema.safeParse({ itemId: value(formData, "itemId") });
  if (!parsed.success) return { status: "error", message: "Invalid post" };

  try {
    const { item, approval } = await requestContentApproval(getDb(), session.organisationId, {
      itemId: parsed.data.itemId, actorKind: "user", actorId: session.userId,
    });
    revalidateItem(item.id, item.clientId);
    return { status: "ok", id: approval.id };
  } catch (error) {
    return failed(error, "Could not send the post for approval");
  }
}

export async function cancelContentItemAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const reason = value(formData, "reason")?.trim();
  const parsed = CancelItemSchema.safeParse({
    itemId: value(formData, "itemId"),
    ...(reason ? { reason } : {}),
  });
  if (!parsed.success) return { status: "error", message: "Invalid post" };

  try {
    const item = await cancelContentItem(getDb(), session.organisationId, {
      itemId: parsed.data.itemId,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateItem(item.id, item.clientId);
    return { status: "ok", id: item.id };
  } catch (error) {
    return failed(error, "Could not cancel the post");
  }
}
