import {
  type ProjectPhaseKey,
  type ProjectPhaseStatus,
  projectPhaseStatusEnum,
  type ProjectStatus,
  projectStatusEnum,
} from "@launchos/db/schema";
import { z } from "zod";

/**
 * The Projects screens' contract, beside the actions rather than in them: a
 * `"use server"` module may only export async functions, and the pages, the
 * forms and the tests all need these labels and bounds.
 *
 * Every bound mirrors what `packages/core/src/projects` already enforces, so a
 * title that is too long is a sentence on the form rather than a thrown Zod
 * error from core.
 *
 * **Nothing here may import `@launchos/core`.** The forms are client
 * components and import this module, so anything it pulls in lands in the
 * browser bundle — and core's barrel reaches, through the proposal document's
 * shared letterhead, all the way to Playwright. The enums come from
 * `@launchos/db/schema` rather than from `@launchos/db` for the same reason:
 * the package root carries the Postgres client, the schema subpath is table
 * definitions and nothing else.
 */

/** Each admin module declares its own `ActionResult` with this shape. */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const PROJECT_STATUSES = projectStatusEnum.enumValues;
export const PHASE_STATUSES = projectPhaseStatusEnum.enumValues;

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  planned: "Planned",
  active: "Active",
  on_hold: "On hold",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/** The step names on the spine, for a picker that has only the key. */
export const PHASE_KEY_LABEL: Record<ProjectPhaseKey, string> = {
  brief: "Brief",
  design: "Design",
  build: "Build",
  review: "Review",
  launch: "Launch",
  care: "Care",
};

/**
 * What each phase status means in the one word the button says. "Not started"
 * rather than "pending" because the client's page borrows this vocabulary and
 * "pending" is ours.
 */
export const PHASE_STATUS_LABEL: Record<ProjectPhaseStatus, string> = {
  pending: "Not started",
  active: "In progress",
  done: "Done",
  skipped: "Not needed",
};

/** `DateKeySchema` in `packages/core/src/projects/shared.ts`. */
const DateKey = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "a date must be YYYY-MM-DD");

const OptionalDateKey = z.union([z.literal(""), DateKey]).optional();

export const CreateProjectSchema = z.object({
  clientId: z.string().uuid("choose the client this build is for"),
  name: z.string().trim().min(1, "give the project a name").max(300),
  summary: z.string().trim().max(4000).optional(),
  // No `.default()`: `zodResolver` types the form by the schema's *input*, and
  // a defaulted field is optional there and required in the output, which the
  // two halves of `useForm` then disagree about. The picker always sends one.
  status: z.enum(PROJECT_STATUSES),
  targetDate: OptionalDateKey,
});
export type CreateProjectValues = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1, "give the project a name").max(300),
  summary: z.string().trim().max(4000).optional(),
  status: z.enum(PROJECT_STATUSES),
  targetDate: OptionalDateKey,
});

export const SetPhaseStatusSchema = z.object({
  projectId: z.string().uuid(),
  phaseId: z.string().uuid(),
  status: z.enum(PHASE_STATUSES),
});

export const AddMilestoneSchema = z.object({
  projectId: z.string().uuid(),
  phaseId: z.union([z.literal(""), z.string().uuid()]).optional(),
  title: z.string().trim().min(1, "a milestone needs a title").max(300),
  detail: z.string().trim().max(4000).optional(),
  targetDate: OptionalDateKey,
  clientVisible: z.boolean().default(true),
});

export const MilestoneVisibilitySchema = z.object({
  projectId: z.string().uuid(),
  milestoneId: z.string().uuid(),
  clientVisible: z.boolean(),
});

export const ReachMilestoneSchema = z.object({
  projectId: z.string().uuid(),
  milestoneId: z.string().uuid(),
});

export const DeliverProjectSchema = z.object({
  projectId: z.string().uuid(),
  note: z.string().trim().max(2000).optional(),
});

/** The first thing that is wrong with the form, in the words the schema used. */
export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

/** A checkbox is absent when unticked, which is not the same as `false` on a partial form. */
export function checked(formData: FormData, name: string): boolean {
  return formData.get(name) === "on" || formData.get(name) === "true";
}

/** A form field, or `undefined` when it was left blank. */
export function value(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
