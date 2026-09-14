"use server";

import {
  addMilestone,
  ClientReviewRefused,
  createProject,
  deliverProject,
  ProjectRefused,
  reachMilestone,
  requestClientReview,
  setPhaseStatus,
  updateMilestone,
  updateProject,
  withdrawClientReview,
} from "@launchos/core";
import { revalidatePath, updateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { PORTFOLIO_CACHE_TAG } from "@/lib/marketing/portfolio";
import { requireAdmin } from "@/lib/session";
import {
  type ActionResult,
  AddMilestoneSchema,
  checked,
  CreateProjectSchema,
  type CreateProjectValues,
  DeliverProjectSchema,
  firstIssue,
  MilestoneVisibilitySchema,
  ReachMilestoneSchema,
  RequestClientReviewSchema,
  SetPhaseStatusSchema,
  UpdateProjectSchema,
  value,
  WithdrawClientReviewSchema,
} from "./schemas";

/**
 * Writing projects from the admin screens.
 *
 * Gated on `requireAdmin` and nothing narrower, exactly like Tasks, Clients,
 * Websites and Domains: a project is delivery work, and delivery is what every
 * member of the team is here to do. The permission vocabulary
 * (`support | content | billing | settings | approvals | access`) has no key
 * for it, and inventing one that only this module reads would be a permission
 * nobody had been granted on the day it shipped.
 *
 * Server Actions accept direct POSTs, so every action re-authorises and
 * re-validates rather than trusting the form it came from.
 */

/**
 * A core refusal is written for the person reading the screen — "Grays CabLine
 * was already delivered." — so it goes straight to the toast. Anything else is
 * ours to log and answer plainly.
 */
function failed(error: unknown, fallback: string): ActionResult {
  if (error instanceof ProjectRefused) return { status: "error", message: error.message };
  // Written for the same reader: "Dean has already been asked to look at
  // Design sign-off." goes to the toast unchanged.
  if (error instanceof ClientReviewRefused) return { status: "error", message: error.message };
  console.error(`[projects] ${fallback}`, { error });
  return { status: "error", message: fallback };
}

/** Both project screens, plus the client whose page carries the strip. */
function revalidateProject(projectId: string, clientId?: string): void {
  revalidatePath("/projects");
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/portal/tasks");
  if (clientId) revalidatePath(`/clients/${clientId}`);
}

/**
 * Starts a build: the six standard phases, no milestones, and the draft case
 * study `createProject` opens for it. A project from an accepted proposal is
 * the worker's job, not a form's.
 */
export async function createProjectAction(values: CreateProjectValues): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = CreateProjectSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the details and try again") };
  const v = parsed.data;

  try {
    const { project } = await createProject(getDb(), session.organisationId, {
      clientId: v.clientId,
      name: v.name,
      ...(v.summary ? { summary: v.summary } : {}),
      status: v.status,
      ...(v.targetDate ? { targetDate: v.targetDate } : {}),
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateProject(project.id, v.clientId);
    return { status: "ok", id: project.id };
  } catch (error) {
    return failed(error, "Could not start that project");
  }
}

/** The headline facts. `delivered_at` is not here; Deliver is its own action. */
export async function updateProjectAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = UpdateProjectSchema.safeParse({
    projectId: value(formData, "projectId"),
    name: value(formData, "name"),
    summary: value(formData, "summary"),
    status: value(formData, "status"),
    targetDate: value(formData, "targetDate") ?? "",
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the project and try again") };
  const v = parsed.data;

  try {
    const project = await updateProject(getDb(), session.organisationId, {
      projectId: v.projectId,
      name: v.name,
      summary: v.summary ?? null,
      status: v.status,
      targetDate: v.targetDate ? v.targetDate : null,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateProject(project.id, project.clientId);
    return { status: "ok", id: project.id };
  } catch (error) {
    return failed(error, "Could not save the project");
  }
}

/**
 * Moves one step of the spine. Any status may follow any other — Shoji works
 * on design and build at once and occasionally reopens a finished step — so
 * there is nothing to refuse here beyond the phase not being on the project.
 */
export async function setPhaseStatusAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = SetPhaseStatusSchema.safeParse({
    projectId: value(formData, "projectId"),
    phaseId: value(formData, "phaseId"),
    status: value(formData, "status"),
  });
  if (!parsed.success) return { status: "error", message: "Could not move that step" };
  const v = parsed.data;

  try {
    await setPhaseStatus(getDb(), session.organisationId, {
      projectId: v.projectId,
      phaseId: v.phaseId,
      status: v.status,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateProject(v.projectId);
    return { status: "ok", id: v.projectId };
  } catch (error) {
    return failed(error, "Could not move that step");
  }
}

export async function addMilestoneAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = AddMilestoneSchema.safeParse({
    projectId: value(formData, "projectId"),
    phaseId: value(formData, "phaseId") ?? "",
    title: value(formData, "title"),
    detail: value(formData, "detail"),
    targetDate: value(formData, "targetDate") ?? "",
    clientVisible: checked(formData, "clientVisible"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the milestone and try again") };
  const v = parsed.data;

  try {
    await addMilestone(getDb(), session.organisationId, {
      projectId: v.projectId,
      ...(v.phaseId ? { phaseId: v.phaseId } : {}),
      title: v.title,
      ...(v.detail ? { detail: v.detail } : {}),
      ...(v.targetDate ? { targetDate: v.targetDate } : {}),
      clientVisible: v.clientVisible,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateProject(v.projectId);
    return { status: "ok", id: v.projectId };
  } catch (error) {
    return failed(error, "Could not add the milestone");
  }
}

/** The one switch that decides whether the client sees a promise at all. */
export async function setMilestoneVisibilityAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = MilestoneVisibilitySchema.safeParse({
    projectId: value(formData, "projectId"),
    milestoneId: value(formData, "milestoneId"),
    clientVisible: value(formData, "clientVisible") === "true",
  });
  if (!parsed.success) return { status: "error", message: "Could not change that milestone" };
  const v = parsed.data;

  try {
    await updateMilestone(getDb(), session.organisationId, {
      projectId: v.projectId,
      milestoneId: v.milestoneId,
      clientVisible: v.clientVisible,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateProject(v.projectId);
    return { status: "ok", id: v.projectId };
  } catch (error) {
    return failed(error, "Could not change that milestone");
  }
}

/**
 * Marks a promise kept. Core is idempotent through `WHERE reached_at IS NULL`,
 * so a second click emails the client nothing — it just says so.
 */
export async function reachMilestoneAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = ReachMilestoneSchema.safeParse({
    projectId: value(formData, "projectId"),
    milestoneId: value(formData, "milestoneId"),
  });
  if (!parsed.success) return { status: "error", message: "Could not mark that milestone" };
  const v = parsed.data;

  try {
    const result = await reachMilestone(getDb(), session.organisationId, {
      projectId: v.projectId,
      milestoneId: v.milestoneId,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateProject(v.projectId);
    if (!result.recorded) return { status: "error", message: "That milestone was already marked as reached." };
    return { status: "ok", id: v.projectId };
  } catch (error) {
    return failed(error, "Could not mark that milestone");
  }
}

/**
 * Sign-off. This is the only thing that can put a client's page at 100%, and
 * it moves the linked case study to `live` so the story becomes writable.
 * Outstanding phases and milestones are deliberately left alone.
 */
export async function deliverProjectAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = DeliverProjectSchema.safeParse({
    projectId: value(formData, "projectId"),
    note: value(formData, "note"),
  });
  if (!parsed.success) return { status: "error", message: "Could not deliver that project" };
  const v = parsed.data;

  try {
    const { project } = await deliverProject(getDb(), session.organisationId, {
      projectId: v.projectId,
      ...(v.note ? { note: v.note } : {}),
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateProject(project.id, project.clientId);
    revalidatePath("/case-studies");
    // Delivery changes a case study's delivery status, which the Work page
    // prints on the card.
    updateTag(PORTFOLIO_CACHE_TAG);
    return { status: "ok", id: project.id };
  } catch (error) {
    return failed(error, "Could not deliver that project");
  }
}

/**
 * Asks the client to look at something.
 *
 * The one thing that was missing: `requestClientReview` has existed, tested,
 * in core since P4b and nothing ever called it — so the portal's "One thing to
 * look at" panel was wired to a queue that could never fill, and the Ops
 * Brief's unanswered-review count could only ever be zero.
 *
 * `requireAdmin` and nothing narrower, like every other action in this module:
 * a review is delivery work. Note what this deliberately does **not** do —
 * send anything. Core writes the card and a client-visible timeline entry and
 * stops; the client meets it in their portal and in the Friday update they
 * already get. Chasing them would contradict the whole point of a review that
 * blocks nothing.
 */
export async function requestClientReviewAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = RequestClientReviewSchema.safeParse({
    projectId: value(formData, "projectId"),
    milestoneId: value(formData, "milestoneId") ?? "",
    note: value(formData, "note"),
    links: value(formData, "links"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the review and try again") };
  const v = parsed.data;

  try {
    const { approval } = await requestClientReview(getDb(), session.organisationId, {
      projectId: v.projectId,
      ...(v.milestoneId ? { milestoneId: v.milestoneId } : {}),
      note: v.note,
      links: v.links,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidateProject(v.projectId);
    return { status: "ok", id: approval.id };
  } catch (error) {
    return failed(error, "Could not ask for that review");
  }
}

/**
 * Takes a review back.
 *
 * Soft delete, which frees the partial unique index so the same thing can be
 * asked about again — the realistic use is a note with the wrong staging URL
 * in it, where the fix is to withdraw and re-ask rather than to leave a card
 * pointing at a dead page.
 *
 * There is no admin route to *answer* one, and there should not be: the client
 * decides a client review. `decideApproval` is reachable from the approvals
 * screen for every other kind, and a review answered by us would put the words
 * "the client is happy with this" on a timeline on nobody's authority.
 */
export async function withdrawClientReviewAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = WithdrawClientReviewSchema.safeParse({
    projectId: value(formData, "projectId"),
    approvalId: value(formData, "approvalId"),
  });
  if (!parsed.success) return { status: "error", message: "Could not withdraw that review" };
  const v = parsed.data;

  try {
    await withdrawClientReview(getDb(), session.organisationId, {
      approvalId: v.approvalId,
      actorId: session.userId,
    });
    revalidateProject(v.projectId);
    return { status: "ok", id: v.approvalId };
  } catch (error) {
    return failed(error, "Could not withdraw that review");
  }
}
