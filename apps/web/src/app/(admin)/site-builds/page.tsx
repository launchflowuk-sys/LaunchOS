import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import { ExternalLink, Hammer, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { approveSiteBuildAction, cancelSiteBuildAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Site builds" };

type Row = typeof schema.siteBuilds.$inferSelect;

const IN_PROGRESS = ["queued", "generating", "provisioning", "uploading"];

/**
 * What is building, what is waiting on a person, and what has gone out.
 *
 * The middle one is the point of the screen. A build at `review` is finished,
 * working, and invisible to the client — and it stays that way until somebody
 * presses Approve here. Nothing on this page emails anybody: approving records
 * that the site may be shown, and that is all it does.
 */
export default async function SiteBuildsPage() {
  const session = await requireAdmin();
  const builds = await getDb()
    .select()
    .from(schema.siteBuilds)
    .where(eq(schema.siteBuilds.organisationId, session.organisationId))
    .orderBy(desc(schema.siteBuilds.createdAt));

  const waiting = builds.filter((row) => row.stage === "review");
  const building = builds.filter((row) => IN_PROGRESS.includes(row.stage));
  const failed = builds.filter((row) => row.stage === "failed");

  const columns: readonly DataListColumn<Row>[] = [
    {
      key: "domain",
      header: "Review site",
      primary: true,
      cell: (row) => (
        <div className="min-w-0">
          {row.websiteUrl ? (
            <a href={row.websiteUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">
              {row.domain} <ExternalLink aria-hidden className="inline size-3.5" />
            </a>
          ) : (
            <span className="font-medium">{row.domain}</span>
          )}
          {row.error ? <p className="text-meta break-words text-danger-fg">{row.error}</p> : null}
        </div>
      ),
    },
    {
      key: "stage",
      header: "Stage",
      status: true,
      cell: (row) => <StatusBadge value={row.stage.replaceAll("_", " ")} />,
    },
    {
      key: "admin",
      header: "WordPress",
      hideOnMobile: true,
      cell: (row) =>
        row.adminUrl ? (
          <a href={row.adminUrl} target="_blank" rel="noreferrer" className="text-meta hover:underline">
            Open wp-admin
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "when",
      header: "Ready",
      className: "whitespace-nowrap",
      cell: (row) => (row.reviewReadyAt ? formatDateTime(row.reviewReadyAt) : "—"),
    },
    {
      key: "decide",
      header: "",
      action: true,
      cell: (row) =>
        row.stage === "review" ? (
          <div className="flex items-center gap-2">
            <ActionForm action={approveSiteBuildAction} success="Approved" ariaLabel={`Approve ${row.domain}`}>
              <input type="hidden" name="buildId" value={row.id} />
              <Button type="submit" size="sm">Approve</Button>
            </ActionForm>
            <ActionForm action={cancelSiteBuildAction} success="Cancelled" ariaLabel={`Cancel ${row.domain}`}>
              <input type="hidden" name="buildId" value={row.id} />
              <Button type="submit" size="sm" variant="destructive-quiet">Cancel</Button>
            </ActionForm>
          </div>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        wide
        title="Site builds"
        description="Websites built from an enquiry. Nothing reaches a client until you approve it."
        category="delivery"
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Waiting on you"
          value={waiting.length}
          hint={waiting.length === 0 ? "Nothing to check" : "Built, working, and not shown to anybody yet"}
          category="delivery"
          icon={ShieldCheck}
          attention={waiting.length > 0}
          attentionTone="warning"
        />
        <StatCard
          label="Building"
          value={building.length}
          hint="Generating, provisioning or uploading"
          category="automation"
          icon={Hammer}
        />
        <StatCard
          label="Failed"
          value={failed.length}
          hint={failed.length === 0 ? "None" : "Check whether hosting was left behind"}
          category="support"
          icon={TriangleAlert}
          attention={failed.length > 0}
        />
      </div>

      {waiting.length > 0 ? (
        <Section
          title="Ready to check"
          description="Open it, look at it properly, then approve. Approving records that it may be shown — it does not email anybody."
        >
          <DataList
            rows={waiting}
            columns={columns}
            getRowKey={(row) => row.id}
            caption="Builds waiting for a decision"
          />
        </Section>
      ) : null}

      <Section title="Every build" description="Newest first.">
        <DataList
          rows={builds}
          columns={columns}
          getRowKey={(row) => row.id}
          caption="Site builds"
          empty={
            <EmptyState icon={Hammer} title="No builds yet">
              A build starts from an enquiry.{" "}
              <Link href="/leads" className="underline">
                Open a lead
              </Link>{" "}
              to begin one.
            </EmptyState>
          }
        />
      </Section>
    </>
  );
}
