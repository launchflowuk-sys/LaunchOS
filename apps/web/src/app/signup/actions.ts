"use server";

import { createEmailAdapter } from "@launchos/channels";
import { createSignupSession, SignupRefused } from "@launchos/core";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { getPayments } from "@/lib/integrations";
import { publicOrganisationId } from "@/lib/public-organisation";
import { installWebEnqueue } from "@/lib/queue";
import { firstIssue, type SignupActionResult, SignupSchema } from "./schemas";

/**
 * "Continue to payment" on `/signup`. Public — there is no session to check —
 * so it validates everything itself and writes only through
 * `createSignupSession`, which records a lead first and then either opens a
 * Checkout session (package with a Stripe price) or provisions the client
 * straight away and emails the first invoice (package without one).
 *
 * Success is a redirect: to Stripe's hosted page, or to `/signup/done`.
 * The payments adapter is the cached process-wide one (`getPayments`) so the
 * mock's session survives to the retrieve on the done page.
 */
export async function startSignupAction(_previous: SignupActionResult | null, formData: FormData): Promise<SignupActionResult> {
  const parsed = SignupSchema.safeParse({
    packageSlug: formData.get("packageSlug"),
    name: formData.get("name"),
    business: formData.get("business"),
    email: formData.get("email"),
    phone: formData.get("phone") ?? "",
  });
  if (!parsed.success) return { status: "error", message: firstIssue(parsed.error, "Check the form and try again") };
  const v = parsed.data;

  const organisationId = await publicOrganisationId();
  if (!organisationId) return { status: "error", message: "Sign-up is not open at the moment. Please contact us instead." };

  // The invoice flow creates a client, which fires `client.created` for
  // onboarding tasks; the web enqueue routes that onto pg-boss.
  installWebEnqueue();
  let url: string;
  try {
    const result = await createSignupSession(
      getDb(),
      organisationId,
      { packageSlug: v.packageSlug, name: v.name, business: v.business, email: v.email, ...(v.phone ? { phone: v.phone } : {}) },
      { payments: getPayments(), email: createEmailAdapter(process.env) },
    );
    url = result.url;
  } catch (error) {
    if (error instanceof SignupRefused) return { status: "error", message: error.message };
    console.error("[signup] could not start the sign-up", { packageSlug: v.packageSlug, error });
    return { status: "error", message: "Something went wrong starting your sign-up. Please try again, or contact us." };
  }
  redirect(url);
}
