"use server";

import { answerFunnelStep, completeFunnelSession, FunnelRefused, publishedFunnelBySlug } from "@launchos/core";
import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { readAttributionCookie } from "@/lib/attribution-server";
import { installWebEnqueue } from "@/lib/queue";
import { clientAddress } from "@/lib/rate-limit";
import { AnswerSchema, type AnswerValues, CompleteSchema, type FunnelActionResult, firstIssue, funnelLimiter } from "./schemas";

/**
 * The two writes a funnel visitor makes.
 *
 * Public and session-less, like `/book`: the funnel is found by its slug, the
 * session by its own unguessable token, and nothing the browser says about an
 * organisation or a lead id is believed. Rate-limited per address for the same
 * reason `/api/public/leads` is — the contact step rings Shoji's phone.
 *
 * Answers are saved one at a time rather than batched at the end. That is not
 * an implementation detail: the contact step is in the middle, and it is
 * written the moment it is answered, so a visitor who closes the tab on the
 * next question has still left a name and a number.
 */

async function requestAddress(): Promise<string> {
  return clientAddress(new Request("http://localhost/", { headers: await headers() }));
}

function refused(error: unknown, fallback: string): FunnelActionResult {
  if (error instanceof FunnelRefused) return { status: "error", message: error.message };
  console.error("[funnel] answer failed", { error });
  return { status: "error", message: fallback };
}

/** Records one answer. Returns the session token so the next answer joins the same walk. */
export async function answerAction(values: AnswerValues): Promise<FunnelActionResult> {
  const parsed = AnswerSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check that answer and try again") };
  const v = parsed.data;

  const address = await requestAddress();
  if (!funnelLimiter.allow(address)) {
    return { status: "error", message: "Too many answers from this connection for now. Try again in an hour, or call us." };
  }

  const funnel = await publishedFunnelBySlug(getDb(), v.slug);
  if (!funnel) return { status: "error", message: "This funnel is not taking answers at the moment." };

  // The acknowledgement email and the owner's bell both leave through the
  // queue once the contact step creates the lead.
  installWebEnqueue();
  // "First visit wins": the campaign that actually brought them, from the
  // `lf_attr` cookie, and only on the answer that starts the walk.
  const attribution = v.token ? undefined : await readAttributionCookie();
  try {
    const result = await answerFunnelStep(getDb(), funnel.organisationId, {
      funnelId: funnel.id,
      ...(v.token ? { token: v.token } : {}),
      stepKey: v.stepKey,
      ...(v.choice ? { choice: v.choice } : {}),
      ...(v.text === undefined ? {} : { text: v.text }),
      ...(v.contact ? { contact: v.contact } : {}),
      ...(attribution ? { attribution } : {}),
    });
    return { status: "ok", token: result.token, captured: result.leadId !== null };
  } catch (error) {
    return refused(error, "Something went wrong saving that. Try again, or call us instead.");
  }
}

/** The last screen. Stamps the walk complete and puts every answer on the lead. */
export async function completeAction(values: { slug: string; token: string }): Promise<FunnelActionResult> {
  const parsed = CompleteSchema.safeParse(values);
  if (!parsed.success) return { status: "error", message: "That funnel session is not one we recognise." };
  const v = parsed.data;

  const funnel = await publishedFunnelBySlug(getDb(), v.slug);
  if (!funnel) return { status: "error", message: "This funnel is not taking answers at the moment." };

  installWebEnqueue();
  try {
    const session = await completeFunnelSession(getDb(), funnel.organisationId, { funnelId: funnel.id, token: v.token });
    return { status: "ok", token: session.token, captured: session.leadId !== null };
  } catch (error) {
    return refused(error, "Something went wrong finishing that. Do not worry — we already have your details.");
  }
}
