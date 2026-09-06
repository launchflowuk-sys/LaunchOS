import { funnelPerformance, getFunnel, listClients, maximumScore, recentFunnelSessions } from "@launchos/core";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { setFunnelStatusAction } from "../actions";
import { FunnelStatusBadge } from "../funnel-status-badge";
import { FunnelForm } from "./funnel-form";
import { StepEditor } from "./step-editor";

export const dynamic = "force-dynamic";

type SessionRow = Awaited<ReturnType<typeof recentFunnelSessions>>[number];

const SESSION_COLUMNS: readonly DataListColumn<SessionRow>[] = [
  {
    key: "started",
    header: "Started",
    primary: true,
    className: "whitespace-nowrap",
    cell: (row) => formatDateTime(row.createdAt),
  },
  {
    key: "how-far",
    header: "How far",
    status: true,
    cell: (row) =>
      row.completedAt ? (
        <StatusBadge value="completed" label="Finished" tone="success" />
      ) : row.leadId ? (
        <StatusBadge value="contacted" label="Left a number" tone="info" />
      ) : (
        <StatusBadge value="started" label="Walked away" tone="neutral" />
      ),
  },
  { key: "answered", header: "Answers", className: "tabular-nums", cell: (row) => row.answered },
  { key: "score", header: "Score", className: "tabular-nums", cell: (row) => row.score },
  {
    key: "lead",
    header: "Lead",
    cell: (row) =>
      row.leadId ? (
        <Link href={`/leads/${row.leadId}`} className="hover:underline">
          Open the lead
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
];

export default async function FunnelDetailPage({ params }: PageProps<"/funnels/[id]">) {
  const session = await requireAdmin();
  const { id } = await params;
  const funnel = await getFunnel(getDb(), session.organisationId, id);
  if (!funnel) notFound();

  const [clients, performance, sessions] = await Promise.all([
    listClients(getDb(), session.organisationId, { status: "active" }),
    funnelPerformance(getDb(), session.organisationId, { funnelId: funnel.id, days: 30 }),
    recentFunnelSessions(getDb(), session.organisationId, { funnelId: funnel.id, limit: 20 }),
  ]);
  const stats = performance.funnels[0];
  const contactAt = funnel.steps.findIndex((step) => step.kind === "contact");

  return (
    <>
      <PageHeader
        title={funnel.name}
        description={`Screen ${contactAt + 1} of ${funnel.steps.length} asks for the name and number. Everything after it is a bonus.`}
        category="delivery"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <FunnelStatusBadge status={funnel.status} />
            {funnel.status === "published" ? (
              <>
                <Button asChild variant="secondary">
                  <a href={`/f/${funnel.slug}`} target="_blank" rel="noreferrer">
                    Open the page
                    <ExternalLink className="size-4" strokeWidth={1.75} aria-hidden />
                  </a>
                </Button>
                <StatusForm funnelId={funnel.id} status="draft" label="Take it down" variant="secondary" />
              </>
            ) : (
              <StatusForm funnelId={funnel.id} status="published" label="Publish" variant="primary" />
            )}
            {funnel.status === "archived" ? null : <StatusForm funnelId={funnel.id} status="archived" label="Archive" variant="destructive-quiet" />}
          </div>
        }
      />

      <Section
        title="The last thirty days"
        description="Started, left a number, finished. The middle one is what a funnel is for."
      >
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Started" value={stats?.starts ?? 0} />
          <Stat label="Left a number" value={stats?.contacts ?? 0} />
          <Stat label="Finished" value={stats?.completions ?? 0} />
          <Stat label="Best score" value={`${stats?.bestScore ?? 0} of ${maximumScore(funnel.steps)}`} />
        </dl>
      </Section>

      <Section title="Settings" description="The address an advert points at, who it belongs to, and when it should ring your phone.">
        <FunnelForm funnel={funnel} clients={clients} bestScore={maximumScore(funnel.steps)} />
      </Section>

      <Section title="Questions" description="One a screen, in this order. Move the contact screen and the funnel stops working — so it cannot go last.">
        <StepEditor funnel={funnel} />
      </Section>

      <Section title="Recent walks" description="Including the ones that stopped. A walk with a lead and no finish is exactly what the middle contact step is for.">
        <DataList
          rows={sessions}
          columns={SESSION_COLUMNS}
          getRowKey={(row) => row.id}
          caption="Funnel sessions"
          empty={<p className="text-sm text-muted-foreground">Nobody has walked this funnel yet.</p>}
        />
      </Section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <dt className="label-caps text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function StatusForm({
  funnelId,
  status,
  label,
  variant,
}: {
  funnelId: string;
  status: "draft" | "published" | "archived";
  label: string;
  variant: "primary" | "secondary" | "destructive-quiet";
}) {
  return (
    <ActionForm action={setFunnelStatusAction} success={`Funnel ${label.toLowerCase()}`} ariaLabel={label}>
      <input type="hidden" name="funnelId" value={funnelId} />
      <input type="hidden" name="status" value={status} />
      <Button type="submit" variant={variant}>
        {label}
      </Button>
    </ActionForm>
  );
}
