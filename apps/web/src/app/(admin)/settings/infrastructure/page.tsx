import { listConnections, listServerOptions, type ConnectionRow } from "@launchos/core";
import { Server } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { syncNowAction } from "./actions";
import { ConnectionForm } from "./connection-form";
import { ImportEnvButton } from "./import-env-button";
import { RemoveConnectionForm } from "./remove-connection-form";

export const dynamic = "force-dynamic";

const PROVIDER_LABEL: Record<ConnectionRow["provider"], string> = {
  hetzner_cloud: "Hetzner Cloud",
  coolify: "Coolify",
};

/**
 * Hetzner accounts and Coolify instances LaunchOS reads from — owner only,
 * because a connection here holds the keys to every server the business
 * runs on.
 */
export default async function InfrastructurePage({ searchParams }: PageProps<"/settings/infrastructure">) {
  const session = await requireAdmin();
  if (session.role !== "owner") {
    return (
      <>
        <PageHeader title="Infrastructure" description="Hetzner accounts and Coolify instances LaunchOS reads from." category="automation" />
        <EmptyState icon={Server} title="Owner only">
          Only the owner can manage infrastructure connections.
        </EmptyState>
      </>
    );
  }

  const db = getDb();
  const [connections, servers, params] = await Promise.all([listConnections(db, session.organisationId), listServerOptions(db, session.organisationId), searchParams]);
  const serverNames = new Map(servers.map((s) => [s.id, s.name]));
  const editId = typeof params.edit === "string" ? params.edit : undefined;
  const editing = editId ? connections.find((c) => c.id === editId) : undefined;

  const failing = connections.filter((c) => c.lastError !== null);
  const lastSync = connections
    .map((c) => c.lastSyncedAt)
    .filter((at): at is Date => at !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const columns: readonly DataListColumn<ConnectionRow>[] = [
    { key: "label", header: "Label", primary: true, cell: (row) => row.label },
    { key: "provider", header: "Provider", cell: (row) => PROVIDER_LABEL[row.provider] },
    {
      key: "baseUrl",
      header: "URL",
      cell: (row) => row.baseUrl ?? <span className="text-muted-foreground">—</span>,
      className: "font-mono text-meta",
    },
    {
      key: "server",
      header: "Server",
      cell: (row) => (row.serverId ? (serverNames.get(row.serverId) ?? "—") : <span className="text-muted-foreground">not linked</span>),
    },
    {
      key: "lastSyncedAt",
      header: "Last sync",
      className: "whitespace-nowrap",
      cell: (row) => (row.lastSyncedAt ? formatDateTime(row.lastSyncedAt) : <span className="text-muted-foreground">Never</span>),
    },
    {
      key: "status",
      header: "Status",
      status: true,
      cell: (row) => (row.lastError ? <span className="text-danger-fg">{row.lastError}</span> : "OK"),
    },
    {
      key: "edit",
      header: "",
      cell: (row) => (
        <a href={`/settings/infrastructure?edit=${row.id}`} className="text-sm font-medium underline underline-offset-2">
          Edit
        </a>
      ),
    },
    {
      key: "remove",
      header: "",
      action: true,
      cell: (row) => <RemoveConnectionForm id={row.id} label={row.label} />,
    },
  ];

  return (
    <>
      <PageHeader wide title="Infrastructure" description="Hetzner accounts and Coolify instances LaunchOS reads from." category="automation" />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Connections" value={connections.length} hint="Hetzner accounts and Coolify instances" category="automation" icon={Server} />
        <StatCard
          label="Failing"
          value={failing.length}
          hint={failing.length === 0 ? "Every connection is healthy" : "Check the token or URL"}
          category="automation"
          icon={Server}
          attention={failing.length > 0}
        />
        <StatCard label="Last sync" value={lastSync ? formatDateTime(lastSync) : "Never"} hint="Most recent successful sync" category="automation" icon={Server} />
      </div>

      <Section
        title="Sync"
        actions={
          <>
            <form action={syncNowAction}>
              <Button type="submit">Sync now</Button>
            </form>
            <ImportEnvButton />
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          Pulls servers and costs from every Hetzner connection, then links Coolify instances to a server by IP.
        </p>
      </Section>

      <Section title={editing ? `Edit ${editing.label}` : "Add a connection"}>
        <div className="rounded-[20px] border bg-card p-5">
          <ConnectionForm
            servers={servers}
            {...(editing
              ? { editing: { id: editing.id, provider: editing.provider, label: editing.label, baseUrl: editing.baseUrl, serverId: editing.serverId } }
              : {})}
          />
        </div>
      </Section>

      <Section title="Connections">
        <DataList
          rows={connections}
          columns={columns}
          getRowKey={(row) => row.id}
          caption="Infrastructure connections"
          empty={<EmptyState icon={Server}>No connections yet. Add one above, or import from .env locally.</EmptyState>}
        />
      </Section>
    </>
  );
}
