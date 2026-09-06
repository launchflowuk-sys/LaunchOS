"use server";

import { acceptProposal, declineProposal, getProposalByToken } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { clientAddress } from "@/lib/rate-limit";
import { AcceptSchema, DeclineSchema, firstIssue, NOT_OPEN, proposalLimiter, type PublicActionResult } from "./schemas";

/**
 * Accepting and declining, from a page with no session.
 *
 * **The token is the whole of the authority, and it is the only thing these
 * actions take.** There is no id-shaped parameter anywhere here, because a
 * handler on the open internet holds exactly one thing the client legitimately
 * gave it. The organisation comes off the proposal row, never off the form.
 *
 * Every refusal answers with the same sentence — see `NOT_OPEN`. A page that
 * distinguished "no such proposal" from "that one expired" would be telling
 * whoever is asking which of the two they hold.
 */

/** The address behind the request, for the per-address limit. A server action only has headers. */
async function requestContext(): Promise<{ address: string; userAgent: string | undefined }> {
  const h = await headers();
  const address = clientAddress(new Request("http://localhost/", { headers: h }));
  return { address, userAgent: h.get("user-agent")?.slice(0, 500) };
}

function value(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}

/**
 * Records a client's yes: their name, their email, the signature they drew and
 * the browser they drew it in.
 *
 * `acceptProposal` is idempotent — two taps 40 ms apart write one acceptance —
 * so a second submission needs no special handling here and gets the same
 * "accepted" page as the first.
 */
export async function acceptProposalAction(_previous: PublicActionResult | null, formData: FormData): Promise<PublicActionResult | null> {
  const parsed = AcceptSchema.safeParse({
    token: value(formData, "token"),
    name: value(formData, "name"),
    email: value(formData, "email"),
    signature: value(formData, "signature"),
    terms: value(formData, "terms"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const v = parsed.data;

  const { address, userAgent } = await requestContext();
  if (!proposalLimiter.allow(address)) {
    return { status: "error", message: "Too many attempts from this connection for now. Try again in an hour, or reply to our email." };
  }

  // Found by token first so the organisation comes from the row. A token that
  // matches nothing gets the same answer as one that is no longer live.
  const proposal = await getProposalByToken(getDb(), v.token);
  if (!proposal) return { status: "error", message: NOT_OPEN };

  // Acceptance queues the client's confirmation, the owner's alert and the
  // countersigned copy through the same bus every other message uses.
  installWebEnqueue();
  try {
    await acceptProposal(getDb(), proposal.organisationId, {
      token: v.token,
      acceptedName: v.name,
      acceptedEmail: v.email,
      signatureSvg: v.signature,
      ip: address,
      ...(userAgent ? { userAgent } : {}),
    });
  } catch (error) {
    console.error("[p] a proposal could not be accepted", { error });
    return { status: "error", message: NOT_OPEN };
  }

  revalidatePath(`/p/${v.token}`);
  revalidatePath("/proposals");
  revalidatePath(`/proposals/${proposal.id}`);
  return null;
}

/** Records a no, with the reason if they gave one. Idempotent for the same reason. */
export async function declineProposalAction(_previous: PublicActionResult | null, formData: FormData): Promise<PublicActionResult | null> {
  const parsed = DeclineSchema.safeParse({ token: value(formData, "token"), reason: value(formData, "reason") });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const v = parsed.data;

  const { address } = await requestContext();
  if (!proposalLimiter.allow(address)) {
    return { status: "error", message: "Too many attempts from this connection for now. Try again in an hour, or reply to our email." };
  }

  const proposal = await getProposalByToken(getDb(), v.token);
  if (!proposal) return { status: "error", message: NOT_OPEN };

  installWebEnqueue();
  try {
    await declineProposal(getDb(), proposal.organisationId, {
      token: v.token,
      ...(v.reason ? { reason: v.reason } : {}),
    });
  } catch (error) {
    console.error("[p] a proposal could not be declined", { error });
    return { status: "error", message: NOT_OPEN };
  }

  revalidatePath(`/p/${v.token}`);
  revalidatePath("/proposals");
  revalidatePath(`/proposals/${proposal.id}`);
  return null;
}
