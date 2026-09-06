"use server";

import { getProjectBySignOffToken, signOffDelivery } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { installWebEnqueue } from "@/lib/queue";
import { clientAddress } from "@/lib/rate-limit";
import { firstIssue, NOT_OPEN, type PublicActionResult, SignOffSchema, signOffLimiter } from "./schemas";

/**
 * Signing off a finished build, from a page with no session.
 *
 * **The token is the whole of the authority, and it is the only thing this
 * action takes.** There is no id-shaped parameter here, because a handler on
 * the open internet holds exactly one thing the client legitimately gave it.
 * The organisation comes off the project row, never off the form.
 *
 * Every refusal answers with the same sentence — see `NOT_OPEN`. This is the
 * proposal page's `acceptProposalAction` for the other end of the job, and it
 * is written the same way on purpose: one shape of public write in this app.
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
 * Records a client's sign-off: their name, their email, the signature they
 * drew and the browser they drew it in.
 *
 * `signOffDelivery` is idempotent — two taps 40 ms apart write one sign-off —
 * so a second submission needs no special handling here and gets the same
 * signed-off page as the first. Everything slow that follows (closing the
 * project, the case study, the countersigned copy) is core's, after its own
 * commit; nothing here waits for it.
 */
export async function signOffDeliveryAction(
  _previous: PublicActionResult | null,
  formData: FormData,
): Promise<PublicActionResult | null> {
  const parsed = SignOffSchema.safeParse({
    token: value(formData, "token"),
    name: value(formData, "name"),
    email: value(formData, "email"),
    signature: value(formData, "signature"),
    terms: value(formData, "terms"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const v = parsed.data;

  const { address, userAgent } = await requestContext();
  if (!signOffLimiter.allow(address)) {
    return { status: "error", message: "Too many attempts from this connection for now. Try again in an hour, or reply to our email." };
  }

  // Found by token first so the organisation comes from the row. A token that
  // matches nothing gets the same answer as one that is no longer signable.
  const project = await getProjectBySignOffToken(getDb(), v.token);
  if (!project) return { status: "error", message: NOT_OPEN };

  // Signing off closes the project, which emits `project.delivered` — the
  // Case Study Writer and the launch screenshots hang off that event, so the
  // web process has to be able to put it on the bus.
  installWebEnqueue();
  try {
    await signOffDelivery(getDb(), project.organisationId, {
      token: v.token,
      signedName: v.name,
      signedEmail: v.email,
      signatureSvg: v.signature,
      ip: address,
      ...(userAgent ? { userAgent } : {}),
    });
  } catch (error) {
    console.error("[d] a handover could not be signed off", { error });
    return { status: "error", message: NOT_OPEN };
  }

  revalidatePath(`/d/${v.token}`);
  revalidatePath("/projects");
  revalidatePath(`/projects/${project.id}`);
  return null;
}
