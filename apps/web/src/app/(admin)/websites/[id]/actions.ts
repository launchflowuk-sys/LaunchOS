"use server";

import { setSiteCmsCredential, siteCredentialResolver } from "@launchos/core";
import { createCmsProviderFromEnv } from "@launchos/integrations";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import {
  TestWordPressConnectionSchema,
  WordPressConnectionSchema,
  type ActionResult,
  type TestWordPressConnectionValues,
  type WordPressConnectionValues,
} from "./schemas";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/**
 * Stores the site's WordPress application password.
 *
 * The value only ever travels inward: it is encrypted by `setSiteCmsCredential`
 * before it reaches a column, it is never returned to the browser, and neither
 * this action nor the audit row it writes records it.
 */
export async function saveWordPressConnectionAction(values: WordPressConnectionValues): Promise<ActionResult> {
  // Server Actions accept direct POSTs: authorise, then re-validate.
  const session = await requireAdmin();
  const parsed = WordPressConnectionSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Invalid connection" };
  try {
    await setSiteCmsCredential(getDb(), session.organisationId, {
      ...parsed.data,
      actorKind: "user",
      actorId: session.userId,
    });
    revalidatePath(`/websites/${parsed.data.siteId}`);
    return { status: "ok", message: "WordPress connection saved" };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * `GET /wp-json/wp/v2/users/me` against the client's site, using the stored
 * credential. Read-only, so it is not approval-gated and not audited — it
 * changes nothing and only ever reaches the site the id names.
 */
export async function testWordPressConnectionAction(values: TestWordPressConnectionValues): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = TestWordPressConnectionSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: "Invalid request" };
  try {
    const db = getDb();
    const cms = createCmsProviderFromEnv(process.env, {
      resolveSiteCredentials: siteCredentialResolver(db, session.organisationId),
    });
    const result = await cms.testConnection({ siteId: parsed.data.siteId });
    if (!result.ok) return { status: "error", message: result.message ?? "The connection test failed" };
    return { status: "ok", message: `Connected as ${result.identity || "the application password's user"}` };
  } catch (error) {
    return { status: "error", message: errorMessage(error) };
  }
}
