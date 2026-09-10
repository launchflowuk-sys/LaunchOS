import {
  captureLeadFromDraft, completeBriefStep, patchBriefSession, RevisionConflict,
  startBriefSession, toSafeSession, validateStep, QUESTIONNAIRE_VERSION,
} from "@launchos/core";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { publicOrganisationId } from "@/lib/public-organisation";
import { clientAddress } from "@/lib/rate-limit";
import {
  funnelLimiter, jsonError, jsonOk, readJsonBody, sameOrigin,
  SESSION_COOKIE, sessionFromRequest, startLimiter,
} from "../shared";

export const dynamic = "force-dynamic";

/** Thirty days, matching the draft's own expiry. */
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * POST — open a draft.
 *
 * The secret is set as an HttpOnly cookie and never appears in the response
 * body. Nothing on the page can read it, so an XSS on the marketing site
 * cannot walk off with somebody's draft.
 */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonError(403, "cross_origin", "That request did not come from here.");
  if (!startLimiter.allow(clientAddress(request))) {
    return jsonError(429, "rate_limited", "Too many attempts. Give it a minute.");
  }

  const organisationId = await publicOrganisationId();
  if (!organisationId) return jsonError(503, "unavailable", "We cannot take that just now.");

  const body = (await readJsonBody(request)) ?? {};
  const { session, secret } = await startBriefSession(getDb(), organisationId, {
    questionnaireVersion: QUESTIONNAIRE_VERSION,
    source: (body.source as Record<string, unknown>) ?? {},
  });

  (await cookies()).set(SESSION_COOKIE, secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });

  return jsonOk({ session });
}

/** GET — the current draft. `no-store` throughout: this is somebody's private answers. */
export async function GET(): Promise<Response> {
  const resolved = await sessionFromRequest();
  if (!resolved) return jsonError(404, "no_session", "No draft here.");
  return jsonOk({ session: toSafeSession(resolved.session) });
}

/**
 * PATCH — save what changed.
 *
 * Two things happen here and the order matters. The patch commits first, then
 * the lead is captured from whatever contact details the draft now holds. That
 * way a failure to create the lead cannot lose the answer, and the capture is
 * driven by committed state rather than by what this particular request
 * happened to carry — somebody who typed their phone two saves ago is still
 * captured when they type their name now.
 */
export async function PATCH(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonError(403, "cross_origin", "That request did not come from here.");
  if (!funnelLimiter.allow(clientAddress(request))) {
    return jsonError(429, "rate_limited", "Slow down a moment.");
  }

  const resolved = await sessionFromRequest();
  if (!resolved) return jsonError(404, "no_session", "No draft here.");

  const body = await readJsonBody(request);
  if (!body) return jsonError(413, "bad_body", "That was too much to save at once.");

  try {
    const result = await patchBriefSession(getDb(), resolved.organisationId, resolved.session.id, {
      mutationId: String(body.mutationId ?? ""),
      expectedRevision: Number(body.expectedRevision ?? 0),
      fields: (body.fields as Record<string, unknown>) ?? {},
    });

    const answers = { ...resolved.session.answers, ...((body.fields as Record<string, unknown>) ?? {}) };
    const capture = await captureLeadFromDraft(getDb(), resolved.organisationId, resolved.session.id, {
      ...(typeof answers.name === "string" ? { name: answers.name } : {}),
      ...(typeof answers.email === "string" && answers.email.includes("@") ? { email: answers.email } : {}),
      ...(typeof answers.phone === "string" ? { phone: answers.phone } : {}),
      ...(typeof answers.business === "string" ? { business: answers.business } : {}),
    }).catch(() => ({ leadId: null, created: false }));

    return jsonOk({
      revision: result.revision,
      savedAt: result.savedAt.toISOString(),
      acknowledged: result.acknowledged,
      // The customer never sees this; the UI uses it to stop asking.
      leadCaptured: capture.leadId !== null,
    });
  } catch (error) {
    if (error instanceof RevisionConflict) {
      // 409 carries the truth so the client can merge non-overlapping fields
      // rather than throwing the customer's typing away.
      return jsonError(409, "revision_conflict", "That draft changed somewhere else.", {
        currentRevision: error.currentRevision,
        answers: error.answers,
      });
    }
    return jsonError(400, "save_failed", error instanceof Error ? error.message : "That did not save.");
  }
}

/**
 * PUT — finish a step.
 *
 * Validated here, not in the browser. A step is complete because the server
 * says the answers meet its requirements, which is the only version of that
 * claim worth storing.
 */
export async function PUT(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonError(403, "cross_origin", "That request did not come from here.");
  if (!funnelLimiter.allow(clientAddress(request))) return jsonError(429, "rate_limited", "Slow down a moment.");

  const resolved = await sessionFromRequest();
  if (!resolved) return jsonError(404, "no_session", "No draft here.");

  const body = await readJsonBody(request);
  if (!body) return jsonError(413, "bad_body", "That was too much at once.");

  const step = Number(body.step ?? 0);
  const check = validateStep(step, resolved.session.answers);
  if (!check.ok) return jsonError(422, "incomplete", "Some answers are still needed.", { errors: check.errors });

  const after = await completeBriefStep(getDb(), resolved.organisationId, resolved.session.id, step);
  return jsonOk(after);
}
