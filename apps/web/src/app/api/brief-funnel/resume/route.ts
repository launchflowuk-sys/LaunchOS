import { renderBrandedEmail } from "@launchos/channels";
import { createEmailAdapter } from "@launchos/channels";
import { brandEmailContext, draftForEmail, exchangeResumeToken, issueResumeToken, supportEmailFor } from "@launchos/core";
import { cookies } from "next/headers";
import { getDb } from "@/lib/db";
import { publicOrganisationId } from "@/lib/public-organisation";
import { clientAddress, RateLimiter } from "@/lib/rate-limit";
import { jsonError, jsonOk, readJsonBody, sameOrigin, SESSION_COOKIE } from "../shared";

export const dynamic = "force-dynamic";

/**
 * Tight, and by address as well as by IP. Guessing which of our customers has a
 * live project is exactly what someone would use this endpoint for, and the
 * generic reply below only holds if the rate does too.
 */
const requestLimiter = new RateLimiter({ limit: 5, windowMs: 15 * 60_000 });

const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * POST — "email me a link back to this".
 *
 * Always answers the same, whether or not there was anything to send. A
 * different reply for a known address turns this into a way to ask whether a
 * given business has a project with us, which is not ours to disclose.
 */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonError(403, "cross_origin", "That request did not come from here.");

  const organisationId = await publicOrganisationId();
  if (!organisationId) return jsonError(503, "unavailable", "We cannot do that just now.");

  const body = await readJsonBody(request);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  // Limited before the lookup, and keyed on the address too, so a script
  // cannot walk a list of addresses from one IP or one address from many.
  const allowed = requestLimiter.allow(clientAddress(request)) && requestLimiter.allow(`email:${email}`);
  const accepted = { sent: true } as const;
  if (!allowed || !email) return jsonOk(accepted);

  const draft = await draftForEmail(getDb(), organisationId, email);
  if (!draft) return jsonOk(accepted);

  const { token, expiresAt } = await issueResumeToken(getDb(), organisationId, draft.sessionId);
  const brand = brandEmailContext(process.env);
  const link = `${brand.appUrl.replace(/\/$/, "")}/start/resume?token=${token}`;

  const { text, html } = renderBrandedEmail({
    preheader: "Pick your website brief up where you left off.",
    heading: "Carry on with your brief",
    paragraphs: [
      "Here is the link back to the website brief you started. Everything you had entered is still there.",
      "The link works once and expires in 48 hours. If it stops working, ask for a new one.",
    ],
    cta: { label: "Carry on", url: link },
    footerNote: `This link expires ${expiresAt.toUTCString()}.`,
    logoUrl: brand.logoUrl,
    appUrl: brand.appUrl,
    supportEmail: brand.supportEmail,
  });

  await createEmailAdapter(process.env)
    .send({
      to: email,
      from: process.env.MAIL_FROM ?? supportEmailFor("hello", process.env),
      subject: "Carry on with your website brief",
      text,
      html,
    })
    // Swallowed on purpose: the reply is generic either way, and a failure here
    // must not become the one case that answers differently.
    .catch(() => undefined);

  return jsonOk(accepted);
}

/**
 * PUT — spend the token.
 *
 * A POST-shaped action behind an explicit button, never a GET. Mail scanners
 * and link previewers fetch every URL in a message before a person sees it, and
 * a token burned by Outlook is a support call nobody can diagnose.
 */
export async function PUT(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return jsonError(403, "cross_origin", "That request did not come from here.");

  const organisationId = await publicOrganisationId();
  if (!organisationId) return jsonError(503, "unavailable", "We cannot do that just now.");

  const body = await readJsonBody(request);
  const token = typeof body?.token === "string" ? body.token : "";

  const result = await exchangeResumeToken(getDb(), organisationId, token);
  // One neutral refusal for unknown, spent, revoked and expired alike.
  if (!result.ok) return jsonError(410, "link_spent", "That link has expired or has already been used.");

  (await cookies()).set(SESSION_COOKIE, result.secret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE,
  });

  return jsonOk({ resumed: true });
}
