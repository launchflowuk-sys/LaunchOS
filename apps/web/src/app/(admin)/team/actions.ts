"use server";

import { createEmailAdapter } from "@launchos/channels";
import {
  createMember, deactivateMember, PERMISSION_KEYS, reissueOneTimePassword, resetTwoFactor,
  setMemberPermissions, TwoFactorResetRefused,
} from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { installWebEnqueue } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";

/** The shape `ActionForm` expects; each admin module declares its own. */
export type ActionResult = { status: "ok" } | { status: "error"; message: string };

export type AddMemberState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "created"; email: string; displayName: string; oneTimePassword: string };

const AddMemberInput = z.object({
  displayName: z.string().trim().min(1, "Name is required").max(200),
  email: z.string().trim().toLowerCase().email("A valid email is required"),
  role: z.enum(["owner", "staff"]).default("staff"),
  title: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().max(100).optional()),
});

/**
 * Returns the one-time password in the action result and nowhere else: it is
 * never persisted in plain text, never revalidated into a page, and never
 * logged. Reloading the Team page cannot show it again.
 */
export async function addMemberAction(_prev: AddMemberState, formData: FormData): Promise<AddMemberState> {
  // Server Actions accept direct POSTs: authorise first. Only an owner may
  // create accounts, since a new account can be an owner.
  const session = await requireAdmin();
  if (session.role !== "owner") return { status: "error", message: "Only an owner can add team members" };
  installWebEnqueue();

  const parsed = AddMemberInput.safeParse({
    displayName: formData.get("displayName"),
    email: formData.get("email"),
    role: formData.get("role") ?? "staff",
    title: formData.get("title") ?? undefined,
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid details" };

  try {
    const { oneTimePassword } = await createMember(getDb(), session.organisationId, {
      ...parsed.data,
      invitedBy: session.userId,
    });
    revalidatePath("/team");
    return {
      status: "created",
      email: parsed.data.email,
      displayName: parsed.data.displayName,
      oneTimePassword,
    };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not add the member" };
  }
}

export type ReissuePasswordState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "issued"; email: string; displayName: string; oneTimePassword: string };

const ReissueInput = z.object({ memberId: z.string().uuid() });

/**
 * The recovery path for a one-time password that never reached the person it
 * was for. Like `addMemberAction` the password exists only in this result: it is
 * never persisted in plain text, never revalidated into a page and never logged.
 *
 * The service refuses anything that is not a member of this organisation who is
 * still on the password they were issued, so this only has to check that the
 * caller is an owner.
 */
export async function reissuePasswordAction(
  _prev: ReissuePasswordState,
  formData: FormData,
): Promise<ReissuePasswordState> {
  const session = await requireAdmin();
  if (session.role !== "owner") return { status: "error", message: "Only an owner can re-issue a password" };

  const parsed = ReissueInput.safeParse({ memberId: formData.get("memberId") });
  if (!parsed.success) return { status: "error", message: "That member could not be identified" };

  try {
    const { member, oneTimePassword } = await reissueOneTimePassword(getDb(), session.organisationId, {
      memberId: parsed.data.memberId,
      actor: session.userId,
    });
    revalidatePath("/team");
    return {
      status: "issued",
      email: member.email,
      displayName: member.displayName ?? member.email,
      oneTimePassword,
    };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not re-issue the password" };
  }
}

export type ResetTwoFactorState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | { status: "done"; email: string; emailed: boolean };

const ResetTwoFactorFormInput = z.object({
  /** The `user.id`, not the membership id: a second factor belongs to the account. */
  userId: z.string().min(1),
  password: z.string().min(1, "Enter your password."),
});

/**
 * An owner takes a team member's second factor off, after re-typing their own
 * password. The recovery path for a lost phone and lost backup codes, which
 * two-factor otherwise makes unrecoverable without SQL.
 *
 * The owner check here is belt to the service's braces: `resetTwoFactor`
 * asserts it for itself and refuses everything a screen might wave through —
 * a staff member, an owner of another organisation, a target outside this one,
 * a wrong password, resetting yourself. Its refusals are written to be read by
 * the person who tripped them, so they are shown verbatim; anything else is a
 * bug and goes to the log.
 */
export async function resetMemberTwoFactorAction(
  _prev: ResetTwoFactorState,
  formData: FormData,
): Promise<ResetTwoFactorState> {
  // Server Actions accept direct POSTs: authorise before reading the form.
  const session = await requireAdmin();
  if (session.role !== "owner") {
    return { status: "error", message: "Only an owner can reset somebody else's two-factor." };
  }

  const parsed = ResetTwoFactorFormInput.safeParse({
    userId: formData.get("userId"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the form." };

  try {
    const result = await resetTwoFactor(
      getDb(),
      session.organisationId,
      { targetUserId: parsed.data.userId, actorId: session.userId, actorPassword: parsed.data.password },
      { email: createEmailAdapter(process.env) },
    );
    revalidatePath("/team");
    return { status: "done", email: result.email, emailed: result.emailed };
  } catch (error) {
    if (error instanceof TwoFactorResetRefused) return { status: "error", message: error.message };
    console.error("resetMemberTwoFactorAction failed", error);
    return { status: "error", message: "That account's two-factor could not be reset." };
  }
}

const DeactivateInput = z.object({ memberId: z.string().uuid() });

/**
 * Bound straight to a `<form action>`, so it returns void. A rejected
 * deactivation (the last active owner, a member of another organisation) is
 * caught and surfaced as a redirect-safe no-op rather than an unhandled server
 * error: the row simply stays active and the page re-renders unchanged.
 */
export async function deactivateMemberAction(formData: FormData): Promise<void> {
  const session = await requireAdmin();
  if (session.role !== "owner") return;
  const parsed = DeactivateInput.safeParse({ memberId: formData.get("memberId") });
  if (!parsed.success) return;
  try {
    await deactivateMember(getDb(), session.organisationId, {
      memberId: parsed.data.memberId,
      actorId: session.userId,
    });
  } catch (error) {
    console.error("deactivateMemberAction failed", error);
  }
  revalidatePath("/team");
}

const PermissionsInput = z.object({ memberId: z.string().uuid() });

/**
 * Saves the five boxes for one member. Only somebody with `settings` may
 * change who can do what (the owner always has it); core refuses to narrow an
 * owner, and that refusal is the message shown.
 *
 * Every key is read: a box that did not post is `false`, so the stored set is
 * exactly what the form showed on submit, never a partial overlay.
 */
export async function setMemberPermissionsAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("settings");
  if (!gate.ok) return { status: "error", message: gate.message };
  const { session } = gate;

  const parsed = PermissionsInput.safeParse({ memberId: formData.get("memberId") });
  if (!parsed.success) return { status: "error", message: "That member could not be identified" };

  const permissions = Object.fromEntries(PERMISSION_KEYS.map((key) => [key, formData.get(key) === "on"]));
  try {
    await setMemberPermissions(getDb(), session.organisationId, {
      memberId: parsed.data.memberId,
      permissions,
      actorId: session.userId,
    });
    revalidatePath("/team");
    // The rail is built from these; the member sees the change on their next request.
    revalidatePath("/", "layout");
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not save the permissions" };
  }
}
