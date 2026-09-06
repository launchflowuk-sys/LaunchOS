"use server";

import { createLead } from "@launchos/core";
import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { CONTACT_EMAIL } from "@/lib/marketing/site";
import { publicOrganisationId } from "@/lib/public-organisation";
import { installWebEnqueue } from "@/lib/queue";
import { clientAddress } from "@/lib/rate-limit";
import { type ContactActionResult, ContactSchema, contactLimiter, firstIssue, HONEYPOT_FIELD } from "./schema";

/**
 * "Send" on `/contact`. Public — there is no session — so it trusts nothing:
 * Zod on every field, a honeypot that drops a bot's post silently, and a
 * per-address limit so a script cannot fill the owner's phone with
 * `lead.created` buzzes. The lead lands on the single active organisation
 * exactly as one posted through `/api/public/leads` does, with
 * `source: "website"` and `actorKind: "client"`, so `/leads` shows the two
 * side by side and the owner's bell rings for both.
 */
export async function sendContactAction(_previous: ContactActionResult | null, formData: FormData): Promise<ContactActionResult> {
  const trap = formData.get(HONEYPOT_FIELD);
  if (typeof trap === "string" && trap.trim().length > 0) return { status: "ok" };

  const parsed = ContactSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    phone: formData.get("phone") ?? "",
    business: formData.get("business") ?? "",
    message: formData.get("message"),
    page: formData.get("page") ?? "",
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const v = parsed.data;

  // `clientAddress` reads a Request; a server action only has the headers,
  // and a Request built from them carries the same `x-forwarded-for`.
  const address = clientAddress(new Request("http://localhost/", { headers: await headers() }));
  if (!contactLimiter.allow(address)) {
    return { status: "error", message: `Too many messages from this connection for now. Email us instead at ${CONTACT_EMAIL}.` };
  }

  const organisationId = await publicOrganisationId();
  if (!organisationId) return { status: "error", message: `The form is not taking messages right now. Email us at ${CONTACT_EMAIL}.` };

  // The owner's bell may fan out to a device (`push.requested`), which the
  // web process routes onto pg-boss only once the enqueue is installed.
  installWebEnqueue();
  try {
    await createLead(getDb(), organisationId, {
      name: v.name,
      email: v.email,
      ...(v.phone ? { phone: v.phone } : {}),
      ...(v.business ? { business: v.business } : {}),
      message: v.message,
      source: "website",
      metadata: { form: "contact", ...(v.page ? { page: v.page } : {}), address },
      actorKind: "client",
    });
  } catch (error) {
    console.error("[marketing/contact] could not record the lead", { error });
    return { status: "error", message: `Something went wrong sending your message. Please try again, or email ${CONTACT_EMAIL}.` };
  }
  return { status: "ok" };
}
