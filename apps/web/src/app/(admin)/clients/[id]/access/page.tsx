import {
  ACCESS_KIND_LABELS, ACCESS_KINDS, accessLog, getClient, isEncryptionConfigured, listAccessEntries, listSites,
  type AccessEntryRow, type AccessKind,
} from "@launchos/core";
import { KeyRound, Lock } from "lucide-react";
import { notFound } from "next/navigation";
import { DataList, type DataListColumn } from "@/components/data-list";
import { InlineAlert } from "@/components/inline-alert";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { sessionPermissions } from "@/lib/permissions";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { ClientTabs } from "../tabs";
import { AccessLogSection } from "./access-log";
import { CopyButton, EntryActions, RevealSecret } from "./entry-controls";
import { AddAccessDialog, type Option } from "./entry-form";

export const dynamic = "force-dynamic";

/** The tab's groups, in order. A kind with no entries shows no group. */
const GROUPS: readonly { title: string; kinds: readonly AccessKind[] }[] = [
  { title: "Dashboards", kinds: ["dashboard"] },
  { title: "Servers", kinds: ["server", "ssh"] },
  { title: "Databases", kinds: ["database"] },
  { title: "DNS & registrar", kinds: ["dns", "registrar"] },
  { title: "Hosting panels", kinds: ["hosting_panel"] },
  { title: "Email", kinds: ["email"] },
  { title: "Other", kinds: ["other"] },
];

const KIND_OPTIONS: readonly Option[] = ACCESS_KINDS.map((kind) => ({ value: kind, label: ACCESS_KIND_LABELS[kind] }));

function address(row: AccessEntryRow): string | null {
  if (!row.host) return null;
  return row.port === null ? row.host : `${row.host}:${row.port}`;
}

function columns(canManage: boolean, sites: readonly Option[]): readonly DataListColumn<AccessEntryRow>[] {
  return [
    {
      key: "label",
      header: "Access",
      primary: true,
      cell: (row) => (
        <>
          <span className="inline-flex flex-wrap items-center gap-2">
            {row.label}
            <StatusBadge value={ACCESS_KIND_LABELS[row.kind]} tone="neutral" />
          </span>
          {row.url ? (
            // Core only stores http(s) URLs, so this is never a `javascript:` link.
            <a href={row.url} target="_blank" rel="noopener noreferrer" className="block text-meta font-normal break-all text-primary hover:underline">
              {row.url}
            </a>
          ) : null}
          {row.siteName ? <span className="block text-meta font-normal text-muted-foreground">{row.siteName}</span> : null}
          {row.notes ? <span className="mt-1 block text-meta font-normal whitespace-pre-line text-muted-foreground">{row.notes}</span> : null}
        </>
      ),
    },
    {
      key: "address",
      header: "Host",
      cell: (row) => {
        const value = address(row);
        return value ? (
          <span className="inline-flex max-w-full items-center gap-1">
            <span className="font-mono text-[0.8125rem] break-words">{value}</span>
            <CopyButton value={value} label="host" />
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
    {
      key: "username",
      header: "Username",
      cell: (row) =>
        row.username ? (
          <span className="inline-flex max-w-full items-center gap-1">
            <span className="break-all">{row.username}</span>
            <CopyButton value={row.username} label="username" />
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "secret",
      header: "Password",
      cell: (row) => <RevealSecret entryId={row.id} clientId={row.clientId} hasSecret={row.hasSecret} canReveal={canManage} />,
    },
    {
      key: "viewed",
      header: "Last viewed",
      className: "whitespace-nowrap",
      cell: (row) =>
        row.lastViewedAt ? (
          <span className="text-muted-foreground">
            {row.lastViewedByName ?? "someone"}, {formatDateTime(row.lastViewedAt)}
          </span>
        ) : (
          <span className="text-muted-foreground">Never</span>
        ),
    },
    {
      key: "actions",
      header: "Actions",
      action: true,
      cell: (row) =>
        canManage ? (
          <EntryActions
            entry={{
              id: row.id, clientId: row.clientId, kind: row.kind, label: row.label, url: row.url, host: row.host, port: row.port,
              username: row.username, siteId: row.siteId, notes: row.notes, hasSecret: row.hasSecret,
            }}
            kinds={KIND_OPTIONS}
            sites={sites}
          />
        ) : null,
    },
  ];
}

export default async function ClientAccessPage({ params }: PageProps<"/clients/[id]/access">) {
  const session = await requireAdmin();
  const id = uuidOr404((await params).id);
  const db = getDb();

  // The org-scoped read: a client of another organisation is a 404, never a page.
  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const [entries, sites, log, permissions] = await Promise.all([
    listAccessEntries(db, session.organisationId, client.id),
    listSites(db, session.organisationId, { clientId: client.id }),
    accessLog(db, session.organisationId, client.id),
    sessionPermissions(),
  ]);
  const canManage = permissions.access;
  const encryptionConfigured = isEncryptionConfigured(process.env);
  const siteOptions: readonly Option[] = sites.map((site) => ({ value: site.id, label: site.name }));
  const cols = columns(canManage, siteOptions);
  const groups = GROUPS.map((group) => ({ ...group, rows: entries.filter((row) => group.kinds.includes(row.kind)) })).filter(
    (group) => group.rows.length > 0,
  );

  return (
    <>
      <PageHeader
        title={client.name}
        description="Where we get in: dashboards, servers, databases and the credentials for them."
        category="delivery"
        actions={canManage ? <AddAccessDialog clientId={client.id} kinds={KIND_OPTIONS} sites={siteOptions} /> : undefined}
      />

      <ClientTabs clientId={client.id} active="access" />

      <p className="mb-6 flex items-start gap-2 text-sm text-muted-foreground">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>Encrypted at rest with the server&apos;s key. Every reveal is recorded — who, when and which entry.</span>
      </p>

      {canManage && !encryptionConfigured ? (
        <InlineAlert tone="warning" className="mb-6">
          SECRETS_ENCRYPTION_KEY is not set on this server, so passwords cannot be saved here yet. Addresses and usernames can.
        </InlineAlert>
      ) : null}
      {canManage ? null : (
        <InlineAlert tone="info" className="mb-6">
          You can see where everything is. Revealing passwords and editing entries needs the <span className="font-medium">access</span> permission — ask an owner.
        </InlineAlert>
      )}

      {groups.length === 0 ? (
        <EmptyState icon={KeyRound}>
          {canManage ? "No access recorded yet. Add the first dashboard or server." : "No access recorded for this client yet."}
        </EmptyState>
      ) : (
        groups.map((group) => (
          <Section key={group.title} title={group.title}>
            <DataList rows={group.rows} columns={cols} getRowKey={(row) => row.id} caption={group.title} />
          </Section>
        ))
      )}

      <AccessLogSection rows={log} />
    </>
  );
}
