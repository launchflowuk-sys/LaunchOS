import { schema } from "@launchos/db";
import { desc, eq } from "drizzle-orm";
import { ExternalLink, Hammer, Send, ShieldCheck, TriangleAlert } from "lucide-react";
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
import { approveSiteBuildAction, cancelSiteBuildAction, notifySiteBuildClientAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata = { title: "Site builds" };

type Row = typeof schema.siteBuilds.$inferSelect;

const IN_PROGRESS = ["queued", "generating", "provisioning", "uploading"];

/**
 * What is building, what is waiting on a person, and what has gone out.
 *
 * The middle one is the point of the screen. A build at `review` is finished,
 * working, and invisible to the client — and it stays that way until somebody
 * presses Approve, and then Send.
 *
 * Two presses, not one. Approving says "I have looked at this and it is good";
 * sending says "the client now has it". Only the second cannot be taken back,
 * so only the second sits behind its own deliberate button — a build never
 * drifts out to a client because a job ticked over.
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
  // Approved and still unsent. The client knows nothing until somebody presses Send.
  const toSend = builds.filter((row) => row.stage === "approved");

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
      cell: (row) => {
        if (row.stage === "review") {
          return (
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
          );
        }

        // Approved, and the client still knows nothing. This press is the one
        // that cannot be taken back.
        if (row.stage === "approved") {
          return (
            <ActionForm action={notifySiteBuildClientAction} success="Sent" ariaLabel={`Send ${row.domain} to the client`}>
              <input type="hidden" name="buildId" value={row.id} />
              <Button type="submit" size="sm">Send to client</Button>
            </ActionForm>
          );
        }

        // Told, but the mail server refused. A person decides whether to go
        // again — nothing retries this on its own.
        if (row.stage === "notified" && row.error) {
          return (
            <ActionForm action={notifySiteBuildClientAction} success="Sent" ariaLabel={`Try sending ${row.domain} again`}>
              <input type="hidden" name="buildId" value={row.id} />
              <Button type="submit" size="sm" variant="secondary">Try again</Button>
            </ActionForm>
          );
        }

        return null;
      },
    },
  ];

  return (
    <>
      <PageHeader
        wide
        title="Site builds"
        description="Websites built from an enquiry. Approve it, look at it, then send it — the client hears nothing until you press Send."
        category="delivery"
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          label="Ready to send"
          value={toSend.length}
          hint={toSend.length === 0 ? "Nothing waiting to go out" : "Approved — the client has not been told yet"}
          category="delivery"
          icon={Send}
          attention={toSend.length > 0}
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
