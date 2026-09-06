"use server";

import { CaseStudyRefused, reorderCaseStudies, updateCaseStudy } from "@launchos/core";
import { revalidatePath, updateTag } from "next/cache";
import { getDb } from "@/lib/db";
import { PORTFOLIO_CACHE_TAG } from "@/lib/marketing/portfolio";
import { requirePermission } from "@/lib/permissions";
import {
  type ActionResult,
  checked,
  firstIssue,
  linesOfText,
  ReorderSchema,
  SetFeaturedSchema,
  SetStatusSchema,
  UpdateCaseStudySchema,
  value,
} from "./schemas";

/**
 * Writing the public portfolio.
 *
 * Gated on `content`, beside the content calendar and for the same reason:
 * this is copy that goes out under LaunchFlow's name, and publishing one puts
 * a client's story — their name, their problem, their numbers — on
 * launchflow.co.uk. Server Actions accept direct POSTs, so the gate is here
 * and not only on the nav link that hides the module.
 *
 * Every write busts the five-minute portfolio cache, so a typo fixed on a
 * Sunday is on the public page on the next request rather than five minutes
 * later. That is the whole point of publishing from a table.
 */

function failed(error: unknown, fallback: string): ActionResult {
  if (error instanceof CaseStudyRefused) return { status: "error", message: error.message };
  console.error(`[case-studies] ${fallback}`, { error });
  return { status: "error", message: fallback };
}

/** Both admin screens, the public pages, and the cached read behind them. */
function revalidateCaseStudy(caseStudyId?: string): void {
  revalidatePath("/case-studies");
  if (caseStudyId) revalidatePath(`/case-studies/${caseStudyId}`);
  // `updateTag` rather than `revalidateTag`: this is a Server Action, and the
  // person who just fixed a sentence must see it on the public page now, not
  // when the five-minute window happens to lapse.
  updateTag(PORTFOLIO_CACHE_TAG);
  revalidatePath("/site");
  revalidatePath("/site/work");
  revalidatePath("/site/products");
}

/** Every field, in one save. A case study stays editable for ever; nobody signed it. */
export async function updateCaseStudyAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = UpdateCaseStudySchema.safeParse({
    caseStudyId: value(formData, "caseStudyId"),
    slug: value(formData, "slug"),
    name: value(formData, "name"),
    clientName: value(formData, "clientName"),
    sector: value(formData, "sector") ?? "",
    summary: value(formData, "summary") ?? "",
    briefClient: value(formData, "briefClient"),
    briefProblem: value(formData, "briefProblem"),
    briefBuilt: value(formData, "briefBuilt"),
    briefResults: value(formData, "briefResults"),
    stack: value(formData, "stack"),
    year: value(formData, "year") ?? "",
    url: value(formData, "url"),
    screenshotDesktop: value(formData, "screenshotDesktop"),
    screenshotMobile: value(formData, "screenshotMobile"),
    kind: value(formData, "kind"),
    status: value(formData, "status"),
    deliveryStatus: value(formData, "deliveryStatus"),
    featured: checked(formData, "featured"),
    charity: checked(formData, "charity"),
    domain: value(formData, "domain"),
    tagline: value(formData, "tagline"),
    description: value(formData, "description"),
    facts: value(formData, "facts"),
    poweredByName: value(formData, "poweredByName"),
    poweredByUrl: value(formData, "poweredByUrl"),
    poweredByLogo: value(formData, "poweredByLogo"),
    poweredByWidth: value(formData, "poweredByWidth") ?? "",
    poweredByHeight: value(formData, "poweredByHeight") ?? "",
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the story and try again") };
  const v = parsed.data;

  // The badge is all-or-nothing: a name with no logo would render an empty
  // image beside the words "Powered by".
  const poweredBy =
    v.poweredByName && v.poweredByUrl && v.poweredByLogo
      ? {
          name: v.poweredByName,
          url: v.poweredByUrl,
          logo: v.poweredByLogo,
          logoWidth: typeof v.poweredByWidth === "number" ? v.poweredByWidth : 600,
          logoHeight: typeof v.poweredByHeight === "number" ? v.poweredByHeight : 156,
        }
      : null;

  try {
    const row = await updateCaseStudy(getDb(), gate.session.organisationId, {
      caseStudyId: v.caseStudyId,
      slug: v.slug,
      name: v.name,
      clientName: v.clientName ?? null,
      sector: v.sector,
      summary: v.summary,
      brief: {
        client: v.briefClient ?? "",
        problem: v.briefProblem ?? "",
        built: v.briefBuilt ?? "",
        results: v.briefResults ?? "",
      },
      stack: linesOfText(v.stack),
      year: typeof v.year === "number" ? v.year : null,
      url: v.url ?? null,
      screenshots: {
        ...(v.screenshotDesktop ? { desktop: v.screenshotDesktop } : {}),
        ...(v.screenshotMobile ? { mobile: v.screenshotMobile } : {}),
      },
      kind: v.kind,
      status: v.status,
      deliveryStatus: v.deliveryStatus,
      featured: v.featured,
      charity: v.charity,
      poweredBy,
      domain: v.domain ?? null,
      tagline: v.tagline ?? null,
      description: v.description ?? null,
      facts: linesOfText(v.facts),
      actorKind: "user",
      actorId: gate.session.userId,
    });
    revalidateCaseStudy(row.id);
    return { status: "ok", id: row.id };
  } catch (error) {
    return failed(error, "Could not save the story");
  }
}

/** The home-page grid flag. Four at most; the pages take the first four in order. */
export async function setFeaturedAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = SetFeaturedSchema.safeParse({
    caseStudyId: value(formData, "caseStudyId"),
    featured: value(formData, "featured") === "true",
  });
  if (!parsed.success) return { status: "error", message: "Could not change that story" };

  try {
    await updateCaseStudy(getDb(), gate.session.organisationId, {
      caseStudyId: parsed.data.caseStudyId,
      featured: parsed.data.featured,
      actorKind: "user",
      actorId: gate.session.userId,
    });
    revalidateCaseStudy(parsed.data.caseStudyId);
    return { status: "ok", id: parsed.data.caseStudyId };
  } catch (error) {
    return failed(error, "Could not change that story");
  }
}

/**
 * Publish, unpublish, or put one back into review. `published_at` is stamped by
 * core on the first publish and never rewritten, so taking a story down to fix
 * a sentence does not make it look new when it comes back.
 */
export async function setCaseStudyStatusAction(formData: FormData): Promise<ActionResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = SetStatusSchema.safeParse({
    caseStudyId: value(formData, "caseStudyId"),
    status: value(formData, "status"),
  });
  if (!parsed.success) return { status: "error", message: "Could not change that story" };

  try {
    await updateCaseStudy(getDb(), gate.session.organisationId, {
      caseStudyId: parsed.data.caseStudyId,
      status: parsed.data.status,
      actorKind: "user",
      actorId: gate.session.userId,
    });
    revalidateCaseStudy(parsed.data.caseStudyId);
    return { status: "ok", id: parsed.data.caseStudyId };
  } catch (error) {
    return failed(error, "Could not change that story");
  }
}

/**
 * The order of the Work page, written from the order of the ids.
 *
 * The whole list is sent rather than a swap, because that is what core takes
 * and it is what makes a partial reorder safe: anything not named keeps its
 * `sort` and therefore lands after the named ones.
 */
export async function reorderCaseStudiesAction(ids: readonly string[]): Promise<ActionResult> {
  const gate = await requirePermission("content");
  if (!gate.ok) return { status: "error", message: gate.message };
  const parsed = ReorderSchema.safeParse({ ids: [...ids] });
  if (!parsed.success) return { status: "error", message: "Could not save that order" };

  try {
    await reorderCaseStudies(getDb(), gate.session.organisationId, {
      ids: parsed.data.ids,
      actorKind: "user",
      actorId: gate.session.userId,
    });
    revalidateCaseStudy();
    return { status: "ok" };
  } catch (error) {
    return failed(error, "Could not save that order");
  }
}
