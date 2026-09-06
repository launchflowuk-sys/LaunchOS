import { schema } from "@launchos/db";
import { z } from "zod";

/**
 * Local to this module rather than shared — every admin module in this app
 * defines its own `ActionResult` with the identical shape so the modules stay
 * independently editable.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/**
 * A date input carries no time. `17:00Z` is used so a task due "today" is not
 * already overdue at 00:01 on the dashboard's overdue count.
 */
export const DUE_TIME_SUFFIX = "T17:00:00.000Z";

export const CreateTaskSchema = z.object({
  clientId: z.string().uuid("Choose a client"),
  title: z.string().trim().min(1, "Title is required").max(200),
  phase: z.enum(schema.taskPhaseEnum.enumValues),
  kind: z.enum(schema.taskKindEnum.enumValues),
  priority: z.enum(schema.taskPriorityEnum.enumValues),
  dueAt: z.string().trim().max(10).optional(),
  assigneeUserId: z.string().trim().max(200).optional(),
  descriptionMd: z.string().trim().max(20000).optional(),
});

export const UpdateTaskStatusSchema = z.object({
  taskId: z.string().uuid(),
  status: z.enum(schema.taskStatusEnum.enumValues),
});

export const AssignTaskSchema = z.object({
  taskId: z.string().uuid(),
  /** An empty select means "unassigned", which the core service takes as null. */
  assigneeUserId: z.string().trim().max(200),
});

export const CommentOnTaskSchema = z.object({
  taskId: z.string().uuid(),
  bodyMd: z.string().trim().min(1, "Write something first").max(10000),
});

/** A checkbox posts nothing when unticked, so the wanted state travels as text. */
const booleanText = z.enum(["true", "false"]).transform((v) => v === "true");

export const ToggleChecklistSchema = z.object({
  taskId: z.string().uuid(),
  index: z.coerce.number().int().min(0).max(49),
  done: booleanText,
});

export const SetTaskVisibilitySchema = z.object({
  taskId: z.string().uuid(),
  clientVisible: booleanText,
});

/** One proof-checklist item ticked or unticked; same shape as the task's own checklist. */
export const TickEvidenceSchema = z.object({
  taskId: z.string().uuid(),
  index: z.coerce.number().int().min(0).max(49),
  done: booleanText,
});

export const AddEvidenceLinkSchema = z.object({
  taskId: z.string().uuid(),
  url: z.string().trim().url("Enter the full link, starting with https://").max(2000),
});

/** Either a link (by its URL) or a screenshot (by its id) comes off the task. */
export const RemoveEvidenceSchema = z
  .object({
    taskId: z.string().uuid(),
    url: z.string().trim().max(2000).optional(),
    attachmentId: z.string().trim().max(200).optional(),
  })
  .refine((v) => Boolean(v.url) !== Boolean(v.attachmentId), { message: "Choose what to remove" });

/**
 * The screenshot upload's ceiling, in bytes. Below core's attachment cap
 * (10 MB) on purpose: a phone screenshot is under 2 MB and the route buffers
 * the whole file before it looks at it.
 */
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/** What a screenshot may be. A PDF of the delivered page is proof too. */
export const SCREENSHOT_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"];
