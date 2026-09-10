import { STAGES } from "@launchos/core";
import type { Metadata } from "next";
import Link from "next/link";
import { BriefFunnel } from "./funnel";

export const metadata: Metadata = {
  // The layout appends " — LaunchFlow"; naming it here too printed it twice.
  title: "Start a project",
  description:
    "Tell us about your business and what you want from it. A few minutes now saves a phone call and gets you a written brief back.",
};

/**
 * The eight-stage brief, on the calm white canvas the handoff specifies.
 *
 * A server component on purpose. It owns the one shared questionnaire
 * definition and hands it to the client shell as a plain prop — a client
 * component that value-imports `@launchos/core` pulls the database driver into
 * the browser bundle, which typechecks perfectly and then fails to build with
 * `Can't resolve 'net'`.
 *
 * It lives under `site/` because `src/proxy.ts` rewrites `/` to `/site` for
 * launchflow.co.uk — so this is `/start` on the public domain, which is the
 * link worth putting in an ad.
 */
export default function StartPage() {
  return (
    /* A section, not a main: the marketing layout already renders one, and two
       is a landmark a screen reader has to choose between. */
    <section className="min-h-dvh bg-[#F5F6F8] px-5 py-10 sm:px-6 sm:py-14">
      <BriefFunnel stages={STAGES} />

      <p className="mx-auto mt-8 max-w-[720px] text-center text-[13.5px] text-[#626D80]">
        Everything saves as you go, so you can come back to it.{" "}
        <Link href="/contact" className="underline underline-offset-4 hover:text-[#111827]">
          Would rather just talk?
        </Link>
      </p>
    </section>
  );
}
