import { getOpsBrief } from "@launchos/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { BriefArticle } from "../brief-article";
import { briefDateLabel } from "../format";

export const dynamic = "force-dynamic";

export default async function BriefPage({ params }: PageProps<"/briefs/[id]">) {
  const session = await requireAdmin();
  const { id } = await params;
  // A malformed id is a 404, not a 22P02 from Postgres rendered as a 500.
  uuidOr404(id);

  // Scoped by organisation in core, so another tenant's brief id is a 404 here.
  const brief = await getOpsBrief(getDb(), session.organisationId, { briefId: id });
  if (!brief) notFound();

  return (
    <>
      <PageHeader
        title={`Ops Brief — ${briefDateLabel(brief.briefDate)}`}
        description="What the agent saw that morning."
        category="automation"
        actions={
          <Link href="/briefs" className="text-sm text-primary underline underline-offset-2">
            All briefs
          </Link>
        }
      />
      <BriefArticle brief={brief} />
    </>
  );
}
