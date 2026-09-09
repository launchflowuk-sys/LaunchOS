import { completePortalPurchase, PurchaseNotLive } from "@launchos/core";
import { ArrowRight, CircleCheck, Clock } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { getPayments } from "@/lib/integrations";
import { installWebEnqueue } from "@/lib/queue";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

export const metadata = { title: "Order confirmed" };

/**
 * Back from Stripe.
 *
 * This completes the purchase rather than waiting for the webhook, so the
 * client sees their project the moment they land instead of a page that says
 * "we will let you know". Both paths run the same `completePortalPurchase`,
 * which claims the row with one conditional UPDATE — so whichever arrives
 * second writes nothing, and a refresh of this page cannot produce a second
 * project.
 *
 * If the session cannot be completed here (Stripe still settling, say), the
 * webhook picks it up. The page says so honestly rather than pretending.
 */
export default async function PurchaseCompletePage({ searchParams }: PageProps<"/portal/services/complete">) {
  const session = await requireClient();
  const params = await searchParams;
  const sessionId = typeof params.session_id === "string" ? params.session_id : null;

  let projectId: string | null = null;
  let trialing = false;
  let settled = false;

  if (sessionId) {
    // Completion creates a project, which emits events the worker turns into
    // notifications; without this the emit is a silent no-op in web.
    installWebEnqueue();
    try {
      const checkout = await getPayments().retrieveCheckoutSession(sessionId);
      const result = await completePortalPurchase(getDb(), session.organisationId, checkout);
      projectId = result.projectId;
      trialing = result.trialing;
      settled = true;
    } catch (error) {
      // Not an error the client can do anything about: the webhook is the
      // backstop and it will land within seconds.
      if (!(error instanceof PurchaseNotLive)) {
        console.error("[portal] could not complete the purchase on return", { sessionId, error });
      }
    }
  }

  return (
    <div className="mx-auto max-w-xl py-6 text-center">
      <span
        aria-hidden
        className="mx-auto flex size-14 items-center justify-center rounded-full bg-success-bg text-success-fg"
      >
        {settled ? <CircleCheck strokeWidth={1.9} className="size-7" /> : <Clock strokeWidth={1.9} className="size-7" />}
      </span>

      <h1 className="mt-5 text-title font-bold tracking-[-0.01em]">
        {settled ? (trialing ? "Your trial has started." : "Thank you — that is all set.") : "We have your order."}
      </h1>

      <p className="mt-3 text-base text-muted-foreground">
        {settled
          ? "We have started work. You can follow it on your progress page, and everything you have paid for is on your invoices."
          : "Your payment is going through. This page will be right in a moment — nothing else is needed from you."}
      </p>

      <div className="mt-7 flex flex-col justify-center gap-3 sm:flex-row">
        <Button asChild size="lg">
          <Link href="/portal/tasks">
            See what happens next
            <ArrowRight aria-hidden strokeWidth={2} className="size-4" />
          </Link>
        </Button>
        <Button asChild variant="secondary" size="lg">
          <Link href={projectId ? "/portal/tasks" : "/portal"}>Back to your portal</Link>
        </Button>
      </div>
    </div>
  );
}
