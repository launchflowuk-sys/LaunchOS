"use server";

import { createLead } from "@launchos/core";
import { headers } from "next/headers";
import { readAttributionCookie } from "@/lib/attribution-server";
import { getDb } from "@/lib/db";
import { publicOrganisationId } from "@/lib/public-organisation";
import { installWebEnqueue } from "@/lib/queue";
import { clientAddress } from "@/lib/rate-limit";
import { firstIssue, HONEYPOT_FIELD, type StartActionResult, StartSchema, startLimiter } from "./schema";

/**
 * "Send it over" at the end of the wizard. Public — there is no session — so it
 * trusts nothing: Zod on every field, a honeypot that drops a bot's post
 * silently, and a per-address limit so a script cannot fill the owner's phone
 * with `lead.created` buzzes. The same posture as `/contact`, because it is the
 * same exposure.
 *
 * The answers go to `leads.qualification` rather than into the message, so the
 * Brief Writer reads fields instead of parsing prose.
 */
export async function startAction(
  _previous: StartActionResult | null,
  formData: FormData,
): Promise<StartActionResult> {
  const trap = formData.get(HONEYPOT_FIELD);
  if (typeof trap === "string" && trap.trim().length > 0) return { status: "ok" };

  const read = (field: string) => formData.get(field) ?? "";
  const parsed = StartSchema.safeParse({
    name: read("name"),
    email: read("email"),
    phone: read("phone"),
    business: read("business"),
    industry: read("industry"),
    tradingStructure: read("tradingStructure"),
    websiteUrl: read("websiteUrl"),
    hasGoogleListing: read("hasGoogleListing"),
    hasFacebookPage: read("hasFacebookPage"),
    serviceArea: read("serviceArea"),
    services: read("services"),
    goals: read("goals"),
    timeline: read("timeline"),
    budget: read("budget"),
    page: read("page"),
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const v = parsed.data;

  // `clientAddress` reads a Request; a server action only has the headers,
  // so it is handed a throwaway one carrying them — the same shape /contact uses.
  const address = clientAddress(new Request("http://localhost/", { headers: await headers() }));
  if (!startLimiter.allow(address)) {
    return { status: "error", message: "That is a lot of enquiries at once. Give it a minute and try again." };
  }

  const organisationId = await publicOrganisationId();
  if (!organisationId) return { status: "error", message: "We could not take that just now. Please email us instead." };

  installWebEnqueue();

  // The message is assembled from what they told us rather than left empty: the
  // leads list, the acknowledgement email and every existing reader show
  // `message`, and a blank one would read as an enquiry with nothing in it when
  // it is the opposite.
  const message = [
    v.goals ? `What they want: ${v.goals}` : undefined,
    v.services ? `What they do: ${v.services}` : undefined,
    v.timeline ? `Timeline: ${v.timeline}` : undefined,
    v.budget ? `Budget: ${v.budget}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n") || "Started the project wizard.";

  await createLead(getDb(), organisationId, {
    name: v.name,
    email: v.email,
    ...(v.phone ? { phone: v.phone } : {}),
    ...(v.business ? { business: v.business } : {}),
    message,
    source: "website-wizard",
    actorKind: "client",
    ...(v.page ? { metadata: { page: v.page } } : {}),
    attribution: await readAttributionCookie(),
    qualification: {
      ...(v.industry ? { industry: v.industry } : {}),
      ...(v.tradingStructure ? { tradingStructure: v.tradingStructure } : {}),
      ...(v.websiteUrl ? { websiteUrl: v.websiteUrl } : {}),
      ...(v.hasGoogleListing ? { hasGoogleListing: v.hasGoogleListing } : {}),
      ...(v.hasFacebookPage ? { hasFacebookPage: v.hasFacebookPage } : {}),
      ...(v.serviceArea ? { serviceArea: v.serviceArea } : {}),
      ...(v.services ? { services: v.services } : {}),
      ...(v.goals ? { goals: v.goals } : {}),
      ...(v.timeline ? { timeline: v.timeline } : {}),
      ...(v.budget ? { budget: v.budget } : {}),
    },
  });

  return { status: "ok" };
}
