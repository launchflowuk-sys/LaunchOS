import { listPackages } from "@launchos/core";
import type { PackageIncludes } from "@launchos/db/schema";
import { InlineAlert } from "@/components/inline-alert";
import { getDb } from "@/lib/db";
import { formatPence } from "@/lib/format";
import { publicOrganisationId } from "@/lib/public-organisation";
import { SignupForm, type SignupPackage } from "./signup-form";
import { SignupShell } from "./signup-shell";

// Public and unauthenticated by position: this route sits outside the
// `(admin)` and `(portal)` groups, so neither shell's `require*` runs here —
// the same way `/sign-in` is public.
export const dynamic = "force-dynamic";

/** What the package gives you, as a short list a buyer can read in a glance. */
function includesLines(includes: PackageIncludes): string[] {
  const lines: string[] = [];
  if (includes.website) lines.push("Website hosting, care and updates");
  if (includes.seo) lines.push("Search engine optimisation");
  if (includes.ads) lines.push("Ad management");
  if (includes.socialPostsPerMonth > 0) lines.push(`${includes.socialPostsPerMonth} social posts a month`);
  if (includes.blogPostsPerMonth > 0) lines.push(`${includes.blogPostsPerMonth} blog post${includes.blogPostsPerMonth === 1 ? "" : "s"} a month`);
  if (includes.gbpUpdatesPerMonth > 0) lines.push(`${includes.gbpUpdatesPerMonth} Google Business Profile updates a month`);
  return lines;
}

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const params = await searchParams;
  const requested = typeof params.package === "string" ? params.package : null;

  const organisationId = await publicOrganisationId();
  const packages = organisationId ? await listPackages(getDb(), organisationId, { activeOnly: true }) : [];
  const cards: SignupPackage[] = packages.map((pkg) => ({
    slug: pkg.slug,
    name: pkg.name,
    description: pkg.description,
    monthlyPrice: formatPence(pkg.monthlyPricePence, pkg.currency),
    setupPrice: pkg.setupPricePence > 0 ? formatPence(pkg.setupPricePence, pkg.currency) : null,
    online: Boolean(pkg.stripePriceId),
    includes: includesLines(pkg.includes),
  }));
  const initialSlug = requested && cards.some((card) => card.slug === requested) ? requested : null;

  return (
    <SignupShell
      title="Sign up to LaunchFlow"
      description="Pick a package, tell us who you are, and you are in. Your portal login arrives by email the moment it is done."
    >
      {cards.length === 0 ? (
        <InlineAlert tone="info" title="Sign-up is not open just yet">
          There are no packages to choose from at the moment. Contact us and we will set you up by hand.
        </InlineAlert>
      ) : (
        <SignupForm packages={cards} initialSlug={initialSlug} />
      )}
    </SignupShell>
  );
}
