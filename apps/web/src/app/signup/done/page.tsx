import { createEmailAdapter } from "@launchos/channels";
import { completeSignup, SignupRefused } from "@launchos/core";
import Link from "next/link";
import { z } from "zod";
import { InlineAlert, type InlineAlertTone } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { getPayments } from "@/lib/integrations";
import { publicOrganisationId } from "@/lib/public-organisation";
import { installWebEnqueue } from "@/lib/queue";
import { SignupShell } from "../signup-shell";

export const dynamic = "force-dynamic";

type Outcome = { tone: InlineAlertTone; title: string; body: string; done: boolean };

const WELCOME: Outcome = {
  tone: "success",
  title: "You're in",
  body: "Check your email for your portal login — it has a temporary password and a link to sign in. Your first invoice is on its way too.",
  done: true,
};

/**
 * Stripe (or the mock) sent the buyer back with a session id. The session
 * is retrieved from the provider — never trusted from the URL — and, once
 * complete, provisioned right here so the buyer gets an answer now; the
 * `checkout.session.completed` webhook does the same later and finds it
 * already done (`completeSignup` is idempotent by session).
 */
async function outcomeForCheckout(sessionId: string): Promise<Outcome> {
  const organisationId = await publicOrganisationId();
  if (!organisationId) return { tone: "warning", title: "Nearly there", body: "Sign-up is not open at the moment. Contact us and we will finish setting you up.", done: false };

  let session;
  try {
    session = await getPayments().retrieveCheckoutSession(sessionId);
  } catch (error) {
    console.error("[signup/done] could not retrieve the checkout session", { sessionId, error });
    return { tone: "warning", title: "We could not confirm the payment yet", body: "If your card was charged, your login will still arrive by email shortly. Otherwise, go back and try again.", done: false };
  }
  if (session.status !== "complete" || session.paymentStatus === "unpaid") {
    return { tone: "info", title: "Payment not finished", body: "The payment has not completed. Go back to sign up to try again, or contact us if your card was charged.", done: false };
  }

  installWebEnqueue();
  try {
    await completeSignup(getDb(), organisationId, { session }, { email: createEmailAdapter(process.env) });
    return WELCOME;
  } catch (error) {
    if (error instanceof SignupRefused) {
      console.warn("[signup/done] signup refused", { sessionId, reason: error.reason });
      return { tone: "warning", title: "We could not finish setting you up", body: `${error.message} If your card was charged, contact us and we will sort it by hand.`, done: false };
    }
    console.error("[signup/done] provisioning failed", { sessionId, error });
    return { tone: "warning", title: "Payment received, set-up still running", body: "Your payment went through. Your portal login will arrive by email as soon as the set-up completes; contact us if it has not come within the hour.", done: false };
  }
}

const SessionId = z.string().trim().min(1).max(200);
const ClientId = z.string().uuid();

export default async function SignupDonePage({ searchParams }: PageProps<"/signup/done">) {
  const params = await searchParams;
  const sessionParam = typeof params.session_id === "string" ? params.session_id : null;
  const clientParam = typeof params.client === "string" ? params.client : null;

  let outcome: Outcome;
  if (sessionParam && SessionId.safeParse(sessionParam).success) {
    outcome = await outcomeForCheckout(sessionParam);
  } else if (clientParam && ClientId.safeParse(clientParam).success) {
    // The invoice flow: the client was provisioned before the redirect and
    // the welcome email carries the invoice link. Nothing from the URL is
    // read back — a uuid in the address bar earns no information.
    outcome = WELCOME;
  } else {
    outcome = { tone: "info", title: "Nothing to finish", body: "This page is where a sign-up lands once it is done. Start from the sign-up page.", done: false };
  }

  return (
    <SignupShell
      narrow
      title={outcome.done ? "Welcome to LaunchFlow" : "Sign-up"}
      description={outcome.done ? "Your account is ready." : "Almost there."}
    >
      <InlineAlert tone={outcome.tone} title={outcome.title}>
        {outcome.body}
      </InlineAlert>
      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
        {outcome.done ? (
          <Button asChild size="lg">
            <Link href="/sign-in">Go to sign in</Link>
          </Button>
        ) : (
          <Button asChild size="lg" variant="secondary">
            <Link href="/signup">Back to sign-up</Link>
          </Button>
        )}
      </div>
    </SignupShell>
  );
}
