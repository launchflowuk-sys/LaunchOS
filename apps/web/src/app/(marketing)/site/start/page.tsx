import { funnelPackageOptions, STAGES, type PackageOption } from "@launchos/core";
import type { Metadata } from "next";
import { getDb } from "@/lib/db";
import { publicOrganisationId } from "@/lib/public-organisation";
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
export default async function StartPage() {
  // Read from the packages table rather than written into the funnel: the list
  // will grow, and a price that lives in two places disagrees with itself the
  // first time one of them moves. An empty list is survivable — the comparison
  // simply shows no monthly figure rather than inventing one.
  const organisationId = await publicOrganisationId();
  const packages: PackageOption[] = organisationId
    ? await funnelPackageOptions(getDb(), organisationId)
    : [];

  return (
    /* A main, not a section: this route sits outside the `(chrome)` group, so
       nothing above it provides the landmark any more. */
    <main className="min-h-dvh bg-[#F5F6F8]">
      <BriefFunnel stages={STAGES} packages={packages} />
    </main>
  );
}
