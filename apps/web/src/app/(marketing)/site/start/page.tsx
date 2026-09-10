import type { Metadata } from "next";
import Link from "next/link";
import { StartWizard } from "./wizard";

export const metadata: Metadata = {
  // The layout appends " — LaunchFlow"; naming it here too printed it twice.
  title: "Start a project",
  description:
    "Tell us about your business and what you want from it. A few minutes now saves a phone call and gets you a written brief back.",
};

/**
 * The wizard, on a ground that steps back out of its way.
 *
 * A dimmed ground behind a white card, which is the effect of an overlay
 * without being one: a real route can be linked from an ad, shared, reloaded
 * and returned to, and does not depend on the page underneath having rendered
 * first. Somebody halfway through on a phone who takes a call comes back to a
 * URL rather than to a closed modal.
 *
 * It lives under `site/` because `src/proxy.ts` rewrites `/` to `/site` for
 * launchflow.co.uk — so this is `/start` on the public domain, which is the
 * link worth putting in an ad.
 */
export default function StartPage() {
  return (
    /* A section, not a main: the marketing layout already renders one, and two
       is a landmark a screen reader has to choose between. */
    <section className="min-h-dvh bg-neutral-950 px-4 py-10 sm:px-6 sm:py-16">
      <StartWizard page="/start" />

      <p className="mx-auto mt-8 max-w-2xl text-center text-meta text-white/55">
        Would rather just talk?{" "}
        <Link href="/contact" className="underline underline-offset-4 hover:text-white">
          Send a message instead
        </Link>
        .
      </p>
    </section>
  );
}
