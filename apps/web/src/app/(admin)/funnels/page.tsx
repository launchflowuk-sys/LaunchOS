import { type FunnelRow, funnelPerformance, listClients, listFunnels } from "@launchos/core";
import { Split } from "lucide-react";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { createFunnelAction } from "./actions";
import { FunnelStatusBadge } from "./funnel-status-badge";

export const dynamic = "force-dynamic";

/** A row and its last thirty days. `contacts` is the number that matters, not `completions`. */
type Row = FunnelRow & { starts: number; contacts: number; completions: number };

const COLUMNS: readonly DataListColumn<Row>[] = [
  {
    key: "name",
    header: "Funnel",
    primary: true,
    cell: (row) => (
      <>
        <Link href={`/funnels/${row.id}`} className="hover:underline">
          {row.name}
        </Link>
        <span className="block font-mono text-meta font-normal text-muted-foreground">/f/{row.slug}</span>
      </>
    ),
  },
  { key: "status", header: "Status", status: true, cell: (row) => <FunnelStatusBadge status={row.status} /> },
  { key: "steps", header: "Screens", className: "tabular-nums", cell: (row) => row.steps.length },
  { key: "starts", header: "Started", className: "tabular-nums", cell: (row) => row.starts },
  {
    key: "contacts",
    header: "Left a number",
    className: "tabular-nums",
    cell: (row) => (
      <>
        <span className="font-semibold">{row.contacts}</span>
        {row.starts > 0 ? (
          <span className="block text-meta font-normal text-muted-foreground">
            {Math.round((row.contacts / row.starts) * 100)}% of starts
          </span>
        ) : null}
      </>
    ),
  },
  { key: "completions", header: "Finished", className: "tabular-nums", cell: (row) => row.completions },
];

export default async function FunnelsPage() {
  const session = await requireAdmin();
  const [funnels, performance, clients] = await Promise.all([
    listFunnels(getDb(), session.organisationId),
    funnelPerformance(getDb(), session.organisationId, { days: 30 }),
    listClients(getDb(), session.organisationId, { status: "active" }),
  ]);

  const stats = new Map(performance.funnels.map((row) => [row.funnelId, row]));
  const rows: Row[] = funnels.map((funnel) => {
    const stat = stats.get(funnel.id);
    return { ...funnel, starts: stat?.starts ?? 0, contacts: stat?.contacts ?? 0, completions: stat?.completions ?? 0 };
  });

  return (
    <>
      <PageHeader
        title="Funnels"
        description="Five or six questions on a phone, with the name and number asked in the middle — so a visitor who stops early has still told us who they are."
        category="delivery"
      />

      <Section
        title="Live and in draft"
        description={`Started, contacted and finished over the last ${performance.days} days. "Left a number" is the one that pays.`}
      >
        <DataList
          rows={rows}
          columns={COLUMNS}
          getRowKey={(row) => row.id}
          caption="Funnels"
          empty={
            <EmptyState icon={Split}>
              No funnels yet. Make one below, edit its questions, then publish it and point an advert at the address.
            </EmptyState>
          }
        />
      </Section>

      <Section
        title="New funnel"
        description="It starts as a draft with six sensible screens and the contact step at three. Change the questions, then publish."
      >
        <ActionForm
          action={createFunnelAction}
          success="Funnel created"
          resetOnSuccess
          ariaLabel="New funnel"
          className="grid gap-4 rounded-xl border bg-card p-5 sm:grid-cols-3 sm:items-end"
        >
          <div className="space-y-1.5">
            <Label htmlFor="funnel-name">Name</Label>
            <Input id="funnel-name" name="name" required maxLength={160} placeholder="Taxi firms — Google Ads" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="funnel-slug">Web address</Label>
            <Input id="funnel-slug" name="slug" maxLength={60} placeholder="taxi-ads" />
            <p className="text-meta text-muted-foreground">The page is /f/&lt;address&gt;. Left blank, it comes from the name.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="funnel-client">Client</Label>
            <NativeSelect id="funnel-client" name="clientId" defaultValue="">
              <option value="">Ours (no client)</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="sm:col-span-3">
            <Button type="submit">Create funnel</Button>
          </div>
        </ActionForm>
      </Section>
    </>
  );
}
