"use server";

import {
  cancelContentItem, ContentRefused, getContentAsset, getContentItem, IMAGE_RENDERABLE_STATUSES, planContentMonth,
  publicAssetUrl, requestContentApproval, updateContentItem,
} from "@launchos/core";
import { QUEUE, type QueueName } from "@launchos/core/queue";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { installWebEnqueue, sendJob } from "@/lib/queue";
import { requirePermission } from "@/lib/permissions";
import { londonInputToDate } from "./schedule-input";
import {
  type ActionResult, CancelItemSchema, EditItemSchema, firstIssue, ItemIdSchema, MonthActionSchema, PickImageSchema,
  RenderImageSchema, type RenderImageActionResult,
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

/**
 * A refusal is a sentence written for the operator; anything else is ours to
 * log. Typed as the failure alone, not `ActionResult`, so it also satisfies
 * the actions whose success carries more than an id.
 */
function failed(error: unknown, fallback: string): { status: "error"; message: string } {
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
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
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
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
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

/**
 * Puts a library image on the post: `image_url` becomes the asset's public
 * URL. The asset is looked up in this organisation first, so an id from
 * another tenant's library (or a deleted one) is a refusal, never a URL.
 */
export async function pickContentImageAction(values: { itemId: string; assetId: string }): Promise<ActionResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  const parsed = PickImageSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: "That image could not be identified" };

  try {
    const db = getDb();
    const [asset, existing] = await Promise.all([
      getContentAsset(db, session.organisationId, { assetId: parsed.data.assetId }),
      getContentItem(db, session.organisationId, { itemId: parsed.data.itemId }),
    ]);
    if (!asset) return { status: "error", message: "That image is no longer in the library" };
    if (!existing) return { status: "error", message: "That post could not be found" };
    // A post carries its own client's photo, never another client's shopfront.
    if (existing.clientId !== asset.clientId) return { status: "error", message: "That image belongs to another client's library" };
    const item = await updateContentItem(db, session.organisationId, {
      itemId: parsed.data.itemId,
      imageUrl: publicAssetUrl(asset.id),
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateItem(item.id, item.clientId);
    return { status: "ok", id: item.id };
  } catch (error) {
    return failed(error, "Could not set the image");
  }
}

/**
 * Asks for the post's picture — a branded graphic, or a generated photograph
 * when the client has opted in and there is budget left.
 *
 * Sent to the worker rather than drawn here. Rendering a template is Satori
 * and Sharp, and core resolves its font out of its own `node_modules`
 * (`@fontsource/geist-sans`), which pnpm does not hoist and Next's
 * `transpilePackages` bundle cannot reach — a render attempted in this process
 * fails at the first font read. The worker resolves it normally, so the queue
 * is not an optimisation here, it is where the work can actually happen.
 *
 * Nothing this queues leaves the building: the picture is written to our own
 * storage volume and the `content_publish` approval is still the only outward
 * gate. The bound on the button is spend, which core caps monthly, and the
 * `render-image:<itemId>` key stops a double-click paying twice while the
 * first job is still queued.
 */
export async function renderContentImageAction(values: {
  itemId: string;
  mode: "auto" | "template" | "ai";
  force?: boolean;
}): Promise<RenderImageActionResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
  installWebEnqueue();
  const parsed = RenderImageSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Choose how to draw the image") };
  const v = parsed.data;

  try {
    // Read the item first: an id from another organisation is "not found"
    // here, before a job is queued, and a post whose picture is settled says
    // so in a sentence rather than as a silent no-op three seconds later.
    const item = await getContentItem(getDb(), session.organisationId, { itemId: v.itemId });
    if (!item) return { status: "error", message: "That post could not be found" };
    if (!IMAGE_RENDERABLE_STATUSES.includes(item.status)) {
      return { status: "error", message: `A ${item.status.replaceAll("_", " ")} post cannot have its picture changed` };
    }

    const queued = await sendJob(
      QUEUE.contentRenderImage,
      { organisationId: session.organisationId, itemId: v.itemId, mode: v.mode, force: v.force },
      // The worker spells this key in `renderImageKey`; it is repeated rather
      // than imported because nothing in `apps/*` may import from `apps/*`.
      { singletonKey: `render-image:${v.itemId}` },
    );
    // `null` is pg-boss telling us an identical job is already queued, which
    // for this button is the honest answer rather than a failure.
    if (queued === null) return { status: "ok", message: "That picture is already being drawn." };
    return { status: "ok", message: "Drawing the picture now — it appears here in a few seconds." };
  } catch (error) {
    if (error instanceof Error && /queue.*(does not exist|not found)/i.test(error.message)) {
      return {
        status: "error",
        message:
          "Drawing images is not switched on yet: the worker has no content.render-image queue. " +
          "Pick a photo from the library for now.",
      };
    }
    return failed(error, "Could not ask for the image");
  }
}

/** Parks the item in Approvals. Approving there is what publishes it. */
export async function requestContentApprovalAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
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
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;
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
