"use server";

import { createMember, deactivateMember, reissueOneTimePassword } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { requireAdmin } from "@/lib/session";

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
