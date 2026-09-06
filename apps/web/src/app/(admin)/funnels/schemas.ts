import { type FunnelStatus, funnelStatusEnum } from "@launchos/db/schema";
import { z } from "zod";

/**
 * The Funnels screens' contract, beside the actions rather than in them: a
 * `"use server"` module may only export async functions.
 *
 * Every bound mirrors `packages/core/src/funnels/crud.ts` and `steps.ts`, so
 * copy that is too long is a sentence on the form rather than a thrown Zod
 * error from core. **Nothing here may import `@launchos/core`** — the step
 * editor is rendered on the client.
 */

export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const FUNNEL_STATUSES = funnelStatusEnum.enumValues;

export const FUNNEL_STATUS_LABEL: Record<FunnelStatus, string> = {
  draft: "Draft",
  published: "Live",
  archived: "Archived",
};

const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "a funnel needs a web address")
  .max(60)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "the web address is lower-case letters, numbers and hyphens");

export const CreateFunnelSchema = z.object({
  name: z.string().trim().min(1, "a funnel needs a name").max(160),
  slug: Slug,
  clientId: z.string().uuid().optional(),
});

export const UpdateFunnelSchema = z.object({
  funnelId: z.string().uuid(),
  name: z.string().trim().min(1, "a funnel needs a name").max(160),
  slug: Slug,
  clientId: z.string().uuid().optional(),
  headline: z.string().trim().max(200).optional(),
  subheadline: z.string().trim().max(400).optional(),
  hotScore: z.coerce.number().int().min(0, "a threshold cannot be negative").max(1000),
  successHeadline: z.string().trim().min(1, "the thank-you screen needs a heading").max(160),
  successBody: z.string().trim().max(600).optional(),
  successCtaLabel: z.string().trim().max(60).optional(),
  successCtaUrl: z.string().trim().max(500).url("that is not a full web address").optional(),
});

export const SetFunnelStatusSchema = z.object({
  funnelId: z.string().uuid(),
  status: z.enum(FUNNEL_STATUSES),
});

export const SaveStepSchema = z.object({
  funnelId: z.string().uuid(),
  stepKey: z.string().trim().min(1).max(60),
  question: z.string().trim().min(1, "a step needs a question").max(300),
  help: z.string().trim().max(300).optional(),
  required: z.boolean(),
  placeholder: z.string().trim().max(120).optional(),
  /** `choice` steps only: one option a line, `Label | points`. */
  options: z.string().max(2000).optional(),
  askEmail: z.boolean(),
  askBusiness: z.boolean(),
  emailRequired: z.boolean(),
});

export const StepMoveSchema = z.object({
  funnelId: z.string().uuid(),
  stepKey: z.string().trim().min(1).max(60),
  direction: z.enum(["up", "down"]),
});

export const AddStepSchema = z.object({
  funnelId: z.string().uuid(),
  kind: z.enum(["choice", "text"]),
});

export const RemoveStepSchema = z.object({
  funnelId: z.string().uuid(),
  stepKey: z.string().trim().min(1).max(60),
});

/** One option a line: `More enquiries | 30`. The points are optional and default to zero. */
export function parseOptionLines(raw: string | undefined): { value: string; label: string; points: number }[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [label = "", points = "0"] = line.split("|").map((part) => part.trim());
      return { value: slugify(label), label, points: Number.parseInt(points, 10) || 0 };
    })
    .filter((option) => option.label.length > 0 && option.value.length > 0);
}

/** The reverse, for the textarea. */
export function optionLines(options: readonly { label: string; points: number }[] | undefined): string {
  return (options ?? []).map((option) => `${option.label} | ${option.points}`).join("\n");
}

/**
 * An option's stable key, from its label. Renaming a label re-keys the option,
 * which only affects answers given after the rename — an answer already stored
 * keeps the words the visitor actually saw, not a key.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function firstIssue(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

export function checked(formData: FormData, name: string): boolean {
  return formData.get(name) === "on" || formData.get(name) === "true";
}

export function value(formData: FormData, name: string): string | undefined {
  const raw = formData.get(name);
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
