"use server";

import { createFunnel, FunnelRefused, getFunnel, setFunnelStatus, updateFunnel } from "@launchos/core";
import type { FunnelStep } from "@launchos/db/schema";
import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import {
  AddStepSchema, checked, CreateFunnelSchema, firstIssue, parseOptionLines,
  RemoveStepSchema, SaveStepSchema, SetFunnelStatusSchema, slugify, StepMoveSchema,
  type ActionResult, UpdateFunnelSchema, value,
} from "./schemas";

/**
 * Editing a funnel.
 *
 * Ungated beyond `requireAdmin`, like Projects and Leads: a funnel is delivery
 * work and the permission vocabulary has no key for it. What it is *not* is
 * public — every one of these goes through core, which re-validates the shape
 * and refuses to publish a funnel whose contact step has drifted to the end.
 */

function failed(error: unknown, fallback: string): ActionResult {
  if (error instanceof FunnelRefused) return { status: "error", message: error.message };
  // Core re-validates the whole step array on every write, so "the contact
  // step cannot be last" arrives here as a Zod issue. It is written for a
  // person; print it rather than swallowing it into a generic apology.
  if (error instanceof ZodError) return { status: "error", message: firstIssue(error, fallback) };
  console.error(`[funnels] ${fallback}`, { error });
  return { status: "error", message: fallback };
}

function revalidateFunnel(funnelId?: string): void {
  revalidatePath("/funnels");
  if (funnelId) revalidatePath(`/funnels/${funnelId}`);
}

export async function createFunnelAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = CreateFunnelSchema.safeParse({
    name: value(formData, "name"),
    slug: value(formData, "slug") ?? slugify(value(formData, "name") ?? ""),
    clientId: value(formData, "clientId"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  try {
    const funnel = await createFunnel(getDb(), session.organisationId, { ...parsed.data, actorId: session.userId });
    revalidateFunnel(funnel.id);
    return { status: "ok", id: funnel.id };
  } catch (error) {
    return failed(error, "The funnel could not be created");
  }
}

/** Name, address, copy, the hot threshold and the thank-you screen, in one save. */
export async function updateFunnelAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = UpdateFunnelSchema.safeParse({
    funnelId: value(formData, "funnelId"),
    name: value(formData, "name"),
    slug: value(formData, "slug"),
    clientId: value(formData, "clientId"),
    headline: value(formData, "headline"),
    subheadline: value(formData, "subheadline"),
    hotScore: value(formData, "hotScore") ?? "0",
    successHeadline: value(formData, "successHeadline"),
    successBody: value(formData, "successBody"),
    successCtaLabel: value(formData, "successCtaLabel"),
    successCtaUrl: value(formData, "successCtaUrl"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const v = parsed.data;
  try {
    await updateFunnel(getDb(), session.organisationId, {
      funnelId: v.funnelId,
      name: v.name,
      slug: v.slug,
      clientId: v.clientId ?? null,
      headline: v.headline ?? "",
      subheadline: v.subheadline ?? "",
      hotScore: v.hotScore,
      success: {
        headline: v.successHeadline,
        body: v.successBody ?? "",
        ...(v.successCtaLabel ? { ctaLabel: v.successCtaLabel } : {}),
        ...(v.successCtaUrl ? { ctaUrl: v.successCtaUrl } : {}),
      },
      actorId: session.userId,
    });
    revalidateFunnel(v.funnelId);
    return { status: "ok", id: v.funnelId };
  } catch (error) {
    return failed(error, "The funnel could not be saved");
  }
}

/** Publish, take down, archive. Core refuses to publish a shape that is not a funnel. */
export async function setFunnelStatusAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = SetFunnelStatusSchema.safeParse({
    funnelId: value(formData, "funnelId"),
    status: value(formData, "status"),
  });
  if (!parsed.success) return { status: "error", message: "That is not a status a funnel can be in" };
  try {
    await setFunnelStatus(getDb(), session.organisationId, { ...parsed.data, actorId: session.userId });
    revalidateFunnel(parsed.data.funnelId);
    return { status: "ok", id: parsed.data.funnelId };
  } catch (error) {
    return failed(error, "The funnel's status could not be changed");
  }
}

/** One step's question, help, options and flags. */
export async function saveStepAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = SaveStepSchema.safeParse({
    funnelId: value(formData, "funnelId"),
    stepKey: value(formData, "stepKey"),
    question: value(formData, "question"),
    help: value(formData, "help"),
    required: checked(formData, "required"),
    placeholder: value(formData, "placeholder"),
    options: formData.get("options") ?? undefined,
    askEmail: checked(formData, "askEmail"),
    askBusiness: checked(formData, "askBusiness"),
    emailRequired: checked(formData, "emailRequired"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the step and try again") };
  const v = parsed.data;

  return writeSteps(session.organisationId, session.userId, v.funnelId, (steps) =>
    steps.map((step) =>
      step.key !== v.stepKey
        ? step
        : {
            ...step,
            question: v.question,
            ...(v.help ? { help: v.help } : { help: undefined }),
            required: v.required,
            ...(step.kind === "text" ? { placeholder: v.placeholder } : {}),
            ...(step.kind === "choice" ? { options: parseOptionLines(v.options) } : {}),
            ...(step.kind === "contact"
              ? { contact: { askEmail: v.askEmail, askBusiness: v.askBusiness, emailRequired: v.emailRequired } }
              : {}),
          },
    ),
  );
}

/** A new question, added at the end — where a follow-up belongs, after the contact step. */
export async function addStepAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = AddStepSchema.safeParse({ funnelId: value(formData, "funnelId"), kind: value(formData, "kind") });
  if (!parsed.success) return { status: "error", message: "That is not a kind of step" };
  const { funnelId, kind } = parsed.data;

  return writeSteps(session.organisationId, session.userId, funnelId, (steps) => {
    const key = freeKey(steps, kind === "choice" ? "question" : "note");
    const step: FunnelStep =
      kind === "choice"
        ? {
            key, kind: "choice", question: "A new question", required: true,
            options: [
              { value: "yes", label: "Yes", points: 10 },
              { value: "no", label: "No", points: 0 },
            ],
          }
        : { key, kind: "text", question: "A new question", required: false, placeholder: "Optional" };
    return [...steps, step];
  });
}

export async function removeStepAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = RemoveStepSchema.safeParse({ funnelId: value(formData, "funnelId"), stepKey: value(formData, "stepKey") });
  if (!parsed.success) return { status: "error", message: "That step is not one of this funnel's" };
  return writeSteps(session.organisationId, session.userId, parsed.data.funnelId, (steps) =>
    steps.filter((step) => step.key !== parsed.data.stepKey),
  );
}

/** Moving a step is how the contact screen is put back in the middle. */
export async function moveStepAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = StepMoveSchema.safeParse({
    funnelId: value(formData, "funnelId"),
    stepKey: value(formData, "stepKey"),
    direction: value(formData, "direction"),
  });
  if (!parsed.success) return { status: "error", message: "That step cannot be moved" };
  const { funnelId, stepKey, direction } = parsed.data;

  return writeSteps(session.organisationId, session.userId, funnelId, (steps) => {
    const from = steps.findIndex((step) => step.key === stepKey);
    const to = direction === "up" ? from - 1 : from + 1;
    if (from === -1 || to < 0 || to >= steps.length) return steps;
    const next = [...steps];
    [next[from], next[to]] = [next[to]!, next[from]!];
    return next;
  });
}

/**
 * Read, transform, write — one place, because every step edit is the same
 * shape and because the whole array is one column.
 *
 * Core validates the whole array on the way in, so an edit that would leave
 * the funnel without a contact step, or with one at the end, is refused with
 * the reason rather than saved and caught later at publish. A funnel is
 * therefore never in a state its own public page could not run.
 */
async function writeSteps(
  organisationId: string,
  actorId: string,
  funnelId: string,
  transform: (steps: FunnelStep[]) => FunnelStep[],
): Promise<ActionResult> {
  try {
    const funnel = await getFunnel(getDb(), organisationId, funnelId);
    if (!funnel) return { status: "error", message: "That funnel is not one of ours." };
    const steps = transform(funnel.steps);
    await updateFunnel(getDb(), organisationId, { funnelId, steps, actorId });
    revalidateFunnel(funnelId);
    return { status: "ok", id: funnelId };
  } catch (error) {
    return failed(error, "The step could not be saved");
  }
}

/** A key nothing else in the funnel is using. */
function freeKey(steps: readonly FunnelStep[], base: string): string {
  const taken = new Set(steps.map((step) => step.key));
  for (let n = 1; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
