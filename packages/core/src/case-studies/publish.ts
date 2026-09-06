import type { Db } from "@launchos/db";
import { z } from "zod";
import { notifyOwner } from "../notifications/notify.js";
import { updateCaseStudy } from "./crud.js";
import { ActorKindSchema, CaseStudyRefused, requireCaseStudy, type CaseStudyRow } from "./shared.js";

/**
 * Putting a story on the public site.
 *
 * This is the only outward-facing thing the Case Study Writer can do, and the
 * one place in P4 where an agent genuinely publishes something the world can
 * read — which is why `case_study_publish` is the writer's single
 * `requires_approval` tool. The kernel parks the run on the card, Shoji reads
 * the whole story on /approvals, and approving it resumes the run, which then
 * calls this. Rejecting it leaves the draft exactly as editable as it was.
 *
 * The checks below are what a page needs to not embarrass anybody: a name, a
 * one-line summary, and a brief with something in every section. A story
 * published with an empty "results" paragraph is a card on the Work page with
 * a hole in it, and the client whose logo is next to it will notice before we
 * do. Refusals are `CaseStudyRefused("not_publishable")` with a sentence the
 * card can show, so Shoji learns *why* on the approvals page rather than after
 * approving.
 *
 * A URL is deliberately not required. Several of the twenty seeded stories are
 * builds that are live behind a client's own domain change, and a story is
 * still worth telling before the DNS moves.
 */

/** The parts of the brief a published story must have said something in. */
export const REQUIRED_BRIEF_SECTIONS = ["client", "problem", "built", "results"] as const;

export const PublishCaseStudyInput = z.object({
  caseStudyId: z.string().uuid(),
  /** `unlisted` publishes it at its address without putting it on the index. */
  unlisted: z.boolean().default(false),
  actorKind: ActorKindSchema.default("user"),
  actorId: z.string().optional(),
  now: z.date().optional(),
});
export type PublishCaseStudyInput = z.input<typeof PublishCaseStudyInput>;

/** The reason a story is not ready, or null when it is. */
export function whyNotPublishable(study: CaseStudyRow): string | null {
  if (!study.name.trim()) return "It has no name yet.";
  if (!study.summary.trim()) return "It has no one-line summary — that is the text on the card.";
  const empty = REQUIRED_BRIEF_SECTIONS.filter((section) => !study.brief[section]?.trim());
  if (empty.length > 0) {
    return `The brief is still empty in: ${empty.join(", ")}. A published story needs something in each.`;
  }
  return null;
}

/**
 * Moves a story to `published` (or `unlisted`).
 *
 * `updateCaseStudy` does the write, so `published_at` is stamped by the same
 * first-publish rule everything else uses and the audit action reads
 * `case_study.published`. Re-publishing an already-published story is a no-op
 * that returns it, because the approval card can be applied twice and the
 * second time must not look like a failure.
 */
export async function publishCaseStudy(
  db: Db,
  organisationId: string,
  input: PublishCaseStudyInput,
): Promise<{ caseStudy: CaseStudyRow; published: boolean }> {
  const v = PublishCaseStudyInput.parse(input);
  const before = await requireCaseStudy(db, organisationId, v.caseStudyId);
  const status = v.unlisted ? "unlisted" : "published";
  if (before.status === status) return { caseStudy: before, published: false };

  const reason = whyNotPublishable(before);
  if (reason) throw new CaseStudyRefused("not_publishable", reason);

  const after = await updateCaseStudy(db, organisationId, {
    caseStudyId: before.id,
    status,
    actorKind: v.actorKind,
    ...(v.actorId ? { actorId: v.actorId } : {}),
    ...(v.now ? { now: v.now } : {}),
  });

  await notifyOwner(db, organisationId, {
    kind: `case_study.${status}`,
    title: `${after.name} is ${status === "published" ? "on the Work page" : "published, unlisted"}`,
    body: after.summary,
    link: `/case-studies/${after.id}`,
  });
  return { caseStudy: after, published: true };
}

/** Takes a story back off the site, keeping its `published_at`. */
export async function unpublishCaseStudy(
  db: Db,
  organisationId: string,
  input: { caseStudyId: string; actorKind?: z.infer<typeof ActorKindSchema>; actorId?: string | undefined },
): Promise<CaseStudyRow> {
  const caseStudyId = z.string().uuid().parse(input.caseStudyId);
  await requireCaseStudy(db, organisationId, caseStudyId);
  return updateCaseStudy(db, organisationId, {
    caseStudyId,
    status: "draft",
    actorKind: input.actorKind ?? "user",
    ...(input.actorId ? { actorId: input.actorId } : {}),
  });
}

export type { CaseStudyRow };
