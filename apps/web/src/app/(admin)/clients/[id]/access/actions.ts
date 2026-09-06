"use server";

import {
  createAccessEntry, deleteAccessEntry, revealAccessSecret, SecretsDecryptError, SecretsKeyError, updateAccessEntry,
} from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import {
  AccessEntryRefSchema, EditAccessEntrySchema, NewAccessEntrySchema,
  type AccessEntryRefValues, type ActionResult, type EditAccessEntryValues, type NewAccessEntryValues, type RevealResult,
} from "./schemas";

/**
 * Every action here is gated on `access`: a hidden button is not a guard, and
 * these are the four ways a stored password is written, removed or read.
 *
 * The path revalidated after a write comes from the `clientId` core returns —
 * the entry's real owner, resolved by `entryId` + organisation — never from the
 * form, so a mismatched pair cannot point the revalidation at another client.
 */

/** The two key errors have a sentence Shoji can act on; anything else is its own message. */
function failed(error: unknown): ActionResult {
  if (error instanceof SecretsKeyError) {
    return { status: "error", message: "Passwords cannot be stored: SECRETS_ENCRYPTION_KEY is not set on the server. Addresses and usernames can still be saved." };
  }
  if (error instanceof SecretsDecryptError) {
    return { status: "error", message: "This password could not be decrypted — the server's encryption key has changed since it was saved. Enter it again." };
  }
  return { status: "error", message: error instanceof Error ? error.message : "Something went wrong" };
}

function accessPath(clientId: string): string {
  return `/clients/${clientId}/access`;
}

export async function createAccessEntryAction(values: NewAccessEntryValues): Promise<ActionResult> {
  const gate = await requirePermission("access");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = NewAccessEntrySchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid entry" };

  try {
    const entry = await createAccessEntry(getDb(), gate.session.organisationId, {
      ...parsed.data, actorKind: "user", actorId: gate.session.userId,
    });
    revalidatePath(accessPath(parsed.data.clientId));
    return { status: "ok", id: entry.id };
  } catch (error) {
    return failed(error);
  }
}

/**
 * Every optional field the form left blank becomes `null` — "clear it" — so an
 * address that has moved can be taken off. The password is the exception:
 * blank leaves it, `clearSecret` removes it, a value replaces it.
 */
export async function updateAccessEntryAction(values: EditAccessEntryValues): Promise<ActionResult> {
  const gate = await requirePermission("access");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = EditAccessEntrySchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid entry" };
  const { entryId, clearSecret, secret, ...fields } = parsed.data;

  try {
    const entry = await updateAccessEntry(getDb(), gate.session.organisationId, {
      entryId,
      kind: fields.kind,
      label: fields.label,
      url: fields.url ?? null,
      host: fields.host ?? null,
      port: fields.port ?? null,
      username: fields.username ?? null,
      siteId: fields.siteId ?? null,
      notes: fields.notes ?? null,
      secret: clearSecret === true ? null : secret,
      actorKind: "user",
      actorId: gate.session.userId,
    });
    revalidatePath(accessPath(entry.clientId));
    return { status: "ok", id: entry.id };
  } catch (error) {
    return failed(error);
  }
}

export async function deleteAccessEntryAction(values: AccessEntryRefValues): Promise<ActionResult> {
  const gate = await requirePermission("access");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = AccessEntryRefSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: "That entry could not be identified" };

  try {
    const deleted = await deleteAccessEntry(getDb(), gate.session.organisationId, {
      entryId: parsed.data.entryId, actorKind: "user", actorId: gate.session.userId,
    });
    revalidatePath(accessPath(deleted.clientId));
    return { status: "ok", id: deleted.id };
  } catch (error) {
    return failed(error);
  }
}

/**
 * The plaintext, once, to the browser that asked. Core writes the
 * `client_access.revealed` audit row and stamps the entry before this returns,
 * so the reveal is on record whether or not the person then copies it. The
 * path is revalidated so the row's "Last viewed" line catches up on the
 * refresh the component asks for.
 */
export async function revealAccessSecretAction(values: AccessEntryRefValues): Promise<RevealResult> {
  const gate = await requirePermission("access");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = AccessEntryRefSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: "That entry could not be identified" };

  try {
    const revealed = await revealAccessSecret(getDb(), gate.session.organisationId, {
      entryId: parsed.data.entryId, actorKind: "user", actorId: gate.session.userId,
    });
    revalidatePath(accessPath(revealed.clientId));
    return { status: "ok", secret: revealed.secret };
  } catch (error) {
    const result = failed(error);
    return { status: "error", message: result.status === "error" ? result.message : "Could not reveal" };
  }
}
