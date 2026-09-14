"use server";

import {
  refreshSiteReviews,
  setSiteCmsCredential,
  setSiteReviewSettings,
  siteCredentialResolver,
  SiteReviewsRefused,
} from "@launchos/core";
import { createCmsProviderFromEnv, createReviewsProviderFromEnv } from "@launchos/integrations";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import {
  RefreshSiteReviewsSchema,
  SiteReviewsSchema,
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

/**
 * Saves the slug, the Google place id and the reviews switch.
 *
 * The slug is what a client's own website puts in `?site=` — so it is a public
 * identifier and unique per organisation, and the unique index is what refuses
 * a duplicate. The message says which so somebody who reuses a slug is told
 * the actual problem rather than "could not save".
 */
export async function saveSiteReviewsAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = SiteReviewsSchema.safeParse({
    siteId: formData.get("siteId"),
    slug: formData.get("slug") ?? "",
    googlePlaceId: formData.get("googlePlaceId") ?? "",
    reviewsEnabled: formData.get("reviewsEnabled") === "on" || formData.get("reviewsEnabled") === "true",
  });
  if (!parsed.success) return { status: "error", message: parsed.error.issues[0]?.message ?? "Check the details" };
  const v = parsed.data;

  try {
    await setSiteReviewSettings(getDb(), session.organisationId, {
      siteId: v.siteId,
      slug: v.slug ?? "",
      googlePlaceId: v.googlePlaceId ?? "",
      reviewsEnabled: v.reviewsEnabled,
      actorId: session.userId,
    });
    revalidatePath(`/websites/${v.siteId}`);
    return { status: "ok", message: v.reviewsEnabled ? "Saved — reviews are on for this site" : "Saved — reviews are off for this site" };
  } catch (error) {
    // 23505 on `sites_org_slug`: another site already answers to this slug.
    const code = (error as { code?: unknown }).code;
    if (code === "23505") {
      return { status: "error", message: "Another website already uses that slug — each one needs its own." };
    }
    return { status: "error", message: errorMessage(error) };
  }
}

/**
 * Reads the listing from Google now, rather than waiting for the 05:10 sweep.
 *
 * The same call the sweep makes, so there is one code path and no "refresh
 * button does something slightly different" bug to find later. A provider
 * refusal comes back as a message rather than an error: "Google does not
 * recognise that place id" is the answer, and it is almost always a typo in
 * the field above the button.
 */
export async function refreshSiteReviewsAction(formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();
  const parsed = RefreshSiteReviewsSchema.safeParse({ siteId: formData.get("siteId") });
  if (!parsed.success) return { status: "error", message: "Could not refresh that site" };

  try {
    const result = await refreshSiteReviews(
      getDb(),
      session.organisationId,
      createReviewsProviderFromEnv(process.env),
      { siteId: parsed.data.siteId },
    );
    revalidatePath(`/websites/${parsed.data.siteId}`);
    if (!result.refreshed) return { status: "error", message: result.reason ?? "Google did not answer" };
    return {
      status: "ok",
      message: `${result.count} Google ${result.count === 1 ? "rating" : "ratings"}, ${result.stored} with a review to show`,
    };
  } catch (error) {
    if (error instanceof SiteReviewsRefused) return { status: "error", message: error.message };
    return { status: "error", message: errorMessage(error) };
  }
}
