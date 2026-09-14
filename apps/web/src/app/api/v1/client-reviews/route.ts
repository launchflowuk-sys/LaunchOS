import { clientReviewSummaries, CLIENT_REVIEW_STALE_DAYS } from "@launchos/core";
import { getDb } from "@/lib/db";
import { authenticateApiRequest, callerMay, forbidden } from "@/lib/api/authenticate";
import { parseEnumParam, parsePaging } from "@/lib/api/paging";
import { apiError, apiOk } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

const STATUSES = ["pending", "approved", "rejected"] as const;

/**
 * Which clients have been asked to look at something, and which have gone
 * quiet.
 *
 * This is the follow-up question to a number the brief already reports.
 * `GET /api/v1/brief` returns `projects.clientReviewsUnanswered` and
 * `oldestClientReviewDays` — a count and an age, with no way to ask *who*.
 * Every other figure in the brief has an endpoint behind it (clients, leads,
 * approvals, incidents, invoices); this was the one that did not, so an
 * assistant could say "two reviews are overdue" and nothing more useful.
 *
 * **Read-only, like `/v1/approvals`, and for a stronger reason.** There the
 * rule is that deciding an approval belongs to a human (CLAUDE.md rule 2).
 * Here it belongs to a *particular* human — the client — so a decision
 * endpoint would not merely bypass Shoji's judgement, it would forge the
 * client's. The portal is the only place a review is answered.
 *
 * Gated on `support`, matching `projects` in `brief-scopes.ts`: a token that
 * can read the count can read the list behind it, and one that cannot read the
 * count cannot get at the same facts by another door.
 *
 * Unlike `/v1/approvals` this one **does** return the note. That withholding
 * exists because an approval's payload is the outward message before anyone
 * has agreed to send it; a review's note is a sentence the client is already
 * reading in their own portal, so there is nothing left to withhold. What is
 * dropped instead is who raised it and the internal target reference — see
 * `ClientReviewSummary`.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  if (!callerMay(auth.caller, "support")) return forbidden("support");

  const params = new URL(request.url).searchParams;
  const paging = parsePaging(params);
  if (!paging.ok) return apiError("bad_request", paging.message);

  const status = parseEnumParam(params.get("status"), STATUSES);
  if (!status.ok) return apiError("bad_request", status.message);

  const projectId = params.get("projectId")?.trim() || undefined;
  const clientId = params.get("clientId")?.trim() || undefined;

  /**
   * `waiting=true` is the question actually worth asking: open, and the client
   * has said nothing at all. It is the same predicate `staleClientReviews`
   * uses for the brief, minus the age cutoff, so the two can never disagree
   * about what "unanswered" means — a review being discussed is not one
   * nobody has looked at, whatever its status column says.
   */
  const waitingOnly = params.get("waiting") === "true";

  const generatedAt = new Date();
  let reviews;
  try {
    reviews = await clientReviewSummaries(getDb(), auth.caller.organisationId, {
      limit: paging.limit,
      ...(status.value ? { status: status.value } : {}),
      ...(projectId ? { projectId } : {}),
      ...(clientId ? { clientId } : {}),
      now: generatedAt,
    });
  } catch {
    // The only way core throws here is a malformed uuid in the query string,
    // which is the caller's mistake and not a 500.
    return apiError("bad_request", "projectId and clientId must be uuids");
  }

  const filtered = waitingOnly ? reviews.filter((review) => !review.answered) : reviews;

  return apiOk(
    {
      reviews: filtered,
      /**
       * Stated rather than left to be counted, because the count is what the
       * brief reports and a caller reconciling the two should not have to
       * reimplement the predicate. `staleDays` names the threshold so an
       * assistant can say "overdue" and mean the same thing LaunchOS does.
       */
      waiting: reviews.filter((review) => !review.answered).length,
      staleDays: CLIENT_REVIEW_STALE_DAYS,
    },
    {
      organisationId: auth.caller.organisationId,
      generatedAt: generatedAt.toISOString(),
    },
  );
}
