import { opsMetricsSnapshot } from "@launchos/core";
import { getDb } from "@/lib/db";
import { authenticateApiRequest } from "@/lib/api/authenticate";
import { scopeBrief } from "@/lib/api/brief-scopes";
import { apiError, apiOk } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

/** Matches `OpsMetricsInput`: an hour at the least, a fortnight at the most. */
const MIN_HOURS = 1;
const MAX_HOURS = 24 * 14;
const DEFAULT_HOURS = 24;

/**
 * What is happening, in one call.
 *
 * This is the endpoint Shoji actually described: wake up, ask Mr. Green what is
 * going on, be told. Everything else in the API is a follow-up question to this
 * answer.
 *
 * **It returns numbers, not prose, and that is deliberate.** The Ops Brief
 * agent writes the in-app brief and is right to, but generating prose here
 * would mean an LLM call on every request — seconds of latency and a cost, to
 * produce something Mr. Green is about to rewrite in its own voice anyway. Mr.
 * Green *is* a language model; handing it facts and letting it speak is both
 * cheaper and better than handing it another model's sentences. The API's job
 * is to be the thing that cannot be wrong.
 *
 * Sections come back only for the scopes the token holds, and the ones withheld
 * are named — see `brief-scopes.ts` for why silence must never be readable as
 * zero.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;

  const raw = new URL(request.url).searchParams.get("hours");
  const hours = raw === null ? DEFAULT_HOURS : Number(raw);
  if (!Number.isInteger(hours) || hours < MIN_HOURS || hours > MAX_HOURS) {
    return apiError("bad_request", `hours must be a whole number between ${MIN_HOURS} and ${MAX_HOURS}`);
  }

  const generatedAt = new Date();
  const snapshot = await opsMetricsSnapshot(getDb(), auth.caller.organisationId, { hours, now: generatedAt });
  const brief = scopeBrief(snapshot, auth.caller.scopes);

  return apiOk(brief, {
    organisationId: auth.caller.organisationId,
    generatedAt: generatedAt.toISOString(),
  });
}
