"use server";

import { issueApiToken, PERMISSION_KEYS, revokeApiToken, type PermissionKey } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdminWith } from "@/lib/permissions";

const PATH = "/settings/api-tokens";

export type IssueTokenState =
  | { status: "idle" }
  | { status: "error"; message: string }
  /**
   * The one and only time the token exists in readable form. It is carried in
   * the action's return value rather than stashed anywhere — not in a cookie,
   * not in a flash message, not in a row — so that closing the page really does
   * destroy it, which is what the screen promises.
   */
  | { status: "issued"; token: string; name: string };

function chosenScopes(form: FormData): PermissionKey[] {
  return PERMISSION_KEYS.filter((key) => form.get(`scope.${key}`) === "on");
}

export async function issueTokenAction(_previous: IssueTokenState, form: FormData): Promise<IssueTokenState> {
  const session = await requireAdminWith("settings");

  const name = String(form.get("name") ?? "").trim();
  if (name === "") return { status: "error", message: "Give the token a name so you can tell it apart later." };

  const days = Number(form.get("expiresInDays") ?? "0");
  if (!Number.isInteger(days) || days < 0 || days > 3650) {
    return { status: "error", message: "Expiry must be a whole number of days, or 0 for no expiry." };
  }

  try {
    const issued = await issueApiToken(getDb(), session.organisationId, {
      name,
      scopes: chosenScopes(form),
      expiresAt: days === 0 ? null : new Date(Date.now() + days * 86_400_000),
      actorId: session.userId,
    });
    revalidatePath(PATH);
    return { status: "issued", token: issued.token, name: issued.name };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not issue the token." };
  }
}

export async function revokeTokenAction(form: FormData): Promise<void> {
  const session = await requireAdminWith("settings");
  const id = String(form.get("id") ?? "");
  if (id) await revokeApiToken(getDb(), session.organisationId, { id, actorId: session.userId });
  revalidatePath(PATH);
}
