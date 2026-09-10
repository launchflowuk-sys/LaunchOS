import { submitBrief } from "@launchos/core";
import { getDb } from "@/lib/db";
import { clientAddress } from "@/lib/rate-limit";
import { funnelLimiter, jsonError, jsonOk, readJsonBody, sameOrigin, sessionFromRequest } from "../shared";

export const dynamic = "force-dynamic";

/**
 * Sending the brief.
 *
 * The idempotency key comes from the browser and is generated once per journey,
 * not per press — so a double tap, a retried timeout and a refresh mid-request
 * all resolve to the same submission and the same reference. That is handled in
 * `submitBrief`; this route only has to pass it through faithfully.
 *
 * A 422 carries the missing fields so the review screen can point at them.
 * Anything else that goes wrong here has already been decided in one
 * transaction — either the brief is stored with its reference, or nothing
 * happened at all.
 */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonError(403, "cross_origin", "That request did not come from here.");
  if (!funnelLimiter.allow(clientAddress(request))) return jsonError(429, "rate_limited", "Slow down a moment.");

  const resolved = await sessionFromRequest();
  if (!resolved) return jsonError(404, "no_session", "No draft here.");

  const body = await readJsonBody(request);
  if (!body) return jsonError(413, "bad_body", "That was too much at once.");

  try {
    const result = await submitBrief(getDb(), resolved.organisationId, resolved.session.id, {
      idempotencyKey: String(body.idempotencyKey ?? ""),
      expectedRevision: Number(body.expectedRevision ?? 0),
    });

    if (result.status === "incomplete") {
      return jsonError(422, "incomplete", "Some answers are still needed.", { errors: result.errors });
    }
    return jsonOk({ reference: result.reference, submissionId: result.submissionId });
  } catch (error) {
    return jsonError(400, "submit_failed", error instanceof Error ? error.message : "That did not send.");
  }
}
