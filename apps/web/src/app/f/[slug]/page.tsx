import { publishedFunnelBySlug } from "@launchos/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AttributionCapture } from "@/components/attribution-capture";
import { appHost, marketingHost } from "@/lib/env";
import { getDb } from "@/lib/db";
import { PublicShell } from "../../(marketing)/site/_components/public-shell";
import { FunnelRunner } from "./funnel-runner";

// Public and unauthenticated by position, like `/book` and `/signup`: outside
// the `(admin)` and `(portal)` groups, so neither shell's `require*` runs. It
// answers on both hosts — the proxy passes `/f/…` through — because the final
// URL on a paid advert is whichever host was typed when the ad was written.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/f/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const funnel = await publishedFunnelBySlug(getDb(), slug);
  return {
    title: funnel ? `${funnel.headline || funnel.name} — LaunchFlow` : "LaunchFlow",
    ...(funnel?.subheadline ? { description: funnel.subheadline } : {}),
    // A funnel is an advert's landing page, not a page for search engines to
    // index: it has no content of its own and would compete with the real one.
    robots: { index: false, follow: false },
  };
}

export default async function FunnelPage({ params }: PageProps<"/f/[slug]">) {
  const { slug } = await params;
  const funnel = await publishedFunnelBySlug(getDb(), slug);
  if (!funnel || funnel.steps.length === 0) notFound();

  return (
    <PublicShell
      narrow
      title={funnel.headline || funnel.name}
      description={funnel.subheadline || "A few quick questions, then we will come back to you."}
    >
      {/* The campaign that paid for this click, kept for thirty days and read
          back by the answer action when the walk starts. */}
      <AttributionCapture ownHosts={[marketingHost(), appHost()]} />
      <FunnelRunner slug={funnel.slug} steps={funnel.steps} success={funnel.success} />
    </PublicShell>
  );
}
