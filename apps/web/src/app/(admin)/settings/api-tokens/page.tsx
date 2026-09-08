import { listApiTokens, PERMISSION_KEYS, PERMISSION_LABELS, type ApiTokenRow } from "@launchos/core";
import { KeyRound } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { revokeTokenAction } from "./actions";
import { IssueTokenForm } from "./issue-token-form";

export const dynamic = "force-dynamic";

const COLUMNS: readonly DataListColumn<ApiTokenRow>[] = [
  { key: "name", header: "Name", primary: true, cell: (row) => row.name },
  { key: "prefix", header: "Token", className: "font-mono text-meta whitespace-nowrap", cell: (row) => `${row.prefix}…` },
  {
    key: "scopes",
    header: "Reads",
    cell: (row) =>
      row.scopes.length === 0
        ? <span className="text-muted-foreground">Nothing</span>
        // The label's first word — "Support", "Billing" — which is the part a
        // person scanning a table is actually looking for.
        : row.scopes.map((scope) => PERMISSION_LABELS[scope].split(" —")[0]).join(", "),
  },
  {
    key: "lastUsed",
    header: "Last used",
    className: "whitespace-nowrap",
    cell: (row) => (row.lastUsedAt ? formatDateTime(row.lastUsedAt) : <span className="text-muted-foreground">Never</span>),
  },
  {
    key: "state",
    header: "State",
    className: "whitespace-nowrap",
    cell: (row) => {
      if (row.revokedAt) return <span className="text-muted-foreground">Revoked {formatDateTime(row.revokedAt)}</span>;
      if (!row.active) return <span className="text-muted-foreground">Expired {row.expiresAt ? formatDateTime(row.expiresAt) : ""}</span>;
      return row.expiresAt ? `Expires ${formatDateTime(row.expiresAt)}` : "Active";
    },
  },
  {
    key: "revoke",
    header: "",
    cell: (row) =>
      row.active ? (
        <form action={revokeTokenAction}>
          <input type="hidden" name="id" value={row.id} />
          <Button type="submit" variant="destructive-quiet" size="sm">Revoke</Button>
        </form>
      ) : null,
  },
];

/**
 * Where the keys to the API live.
 *
 * The reason this screen exists rather than an environment variable: a token
 * held on a laptop has to be killable in a second, by a person, without a
 * deploy. Everything else here follows from that.
 */
export default async function ApiTokensPage() {
  const session = await requireAdmin();
  const tokens = await listApiTokens(getDb(), session.organisationId);
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  return (
    <>
      <PageHeader
        title="API tokens"
        description="Keys for things outside LaunchOS that need to read it — Mr. Green first."
        category="automation"
      />

      <Section title="Issue a token">
        <div className="rounded-[20px] border bg-card p-5">
          <IssueTokenForm scopes={PERMISSION_KEYS.map((key) => ({ key, label: PERMISSION_LABELS[key] }))} />
        </div>
      </Section>

      <Section title="Tokens" description="Revoked and expired ones stay listed, so you can see what you have already dealt with.">
        <DataList
          rows={tokens}
          columns={COLUMNS}
          getRowKey={(row) => row.id}
          caption="API tokens"
          empty={<EmptyState icon={KeyRound}>No tokens yet. Issue one above and give it to Mr. Green.</EmptyState>}
        />
      </Section>

      <Section title="Using it" description="Send the token as a bearer. Every endpoint is read-only.">
        <div className="space-y-3 rounded-[20px] border bg-card p-5">
          <p className="font-mono text-sm break-all">GET {appUrl}/api/v1/brief</p>
          <p className="font-mono text-sm break-all text-muted-foreground">Authorization: Bearer los_…</p>
          <p className="text-sm text-muted-foreground">
            Add <code className="font-mono">?hours=</code> to change the window — 24 by default, 336 at most. The reply names
            any section the token was not scoped to read, so nothing it could not see is mistaken for nothing happening.
          </p>
        </div>
      </Section>
    </>
  );
}
