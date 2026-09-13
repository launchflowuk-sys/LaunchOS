import { recordLatestTouch } from "@launchos/core";
import { getDb } from "@/lib/db";
import { clientAddress } from "@/lib/rate-limit";
import { funnelLimiter, jsonError, jsonOk, readJsonBody, sameOrigin, sessionFromRequest } from "../shared";

export const dynamic = "force-dynamic";

/**
 * POST — this visitor came back on a different campaign.
 *
 * The draft is opened once and its cookie lasts thirty days, so a person who
 * clicks an advert, gets as far as their phone number, closes the tab and
 * clicks a second advert a week later arrives with `GET /session` returning
 * the draft they already had. The campaign on that second URL was simply
 * dropped: `POST /session` is the only place source metadata was ever read,
 * and it does not run for a returning visitor. Every penny of the second click
 * was invisible.
 *
 * This records it as a **later touch**, beside the original rather than over
 * it. `recordLatestTouch` refuses anything that is not a campaign key, so a
 * bookmark reopened twice a day writes nothing at all.
 *
 * Public, like every other endpoint here: same-origin, rate-limited, a capped
 * body, and the cookie secret as the only thing that names a draft.
 */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonError(403, "cross_origin", "That request did not come from here.");
  if (!funnelLimiter.allow(clientAddress(request))) return jsonError(429, "rate_limited", "Slow down a moment.");

  const resolved = await sessionFromRequest();
  // Not an error worth telling the browser about: with no draft there is
  // nothing to attribute, and the next `POST /session` records the campaign as
  // the first touch anyway, which is the right answer.
  if (!resolved) return jsonOk({ recorded: false });

  const body = await readJsonBody(request);
  if (!body) return jsonError(413, "bad_body", "That was too much at once.");

  await recordLatestTouch(getDb(), resolved.organisationId, resolved.session.id, (body.source as Record<string, unknown>) ?? {});
  return jsonOk({ recorded: true });
}
