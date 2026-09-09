import { listApiTokens, PERMISSION_KEYS, PERMISSION_LABELS, type ApiTokenRow } from "@launchos/core";
import { Activity, KeyRound, ShieldOff, Clock } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
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
 * What a token can reach, and what each one needs to be scoped to.
 *
 * Written down here because the alternative is reading eight route files. It
 * lives beside the token list on purpose: the question "what is this key for"
 * and the question "what could someone do with it" are the same question, and
 * they were on different screens.
 */
const ENDPOINTS: readonly { method: "GET" | "POST"; path: string; scope: string; what: string }[] = [
  { method: "GET", path: "/api/v1/brief", scope: "Whatever it holds", what: "The last 24 hours, one section per area the token can read. Add ?hours= up to 336." },
  { method: "GET", path: "/api/v1/clients", scope: "Support", what: "The client roster. ?status= and ?q= to narrow it." },
  { method: "GET", path: "/api/v1/leads", scope: "Support", what: "Enquiries that came in." },
  { method: "GET", path: "/api/v1/incidents", scope: "Support", what: "Sites that went down and what happened next." },
  { method: "GET", path: "/api/v1/invoices", scope: "Billing", what: "Invoices and what has been settled." },
  { method: "GET", path: "/api/v1/approvals", scope: "Approvals", what: "What the agents are waiting on a person to decide." },
  { method: "GET", path: "/api/v1/capabilities", scope: "Settings", what: "Every agent and tool, generated from the registry the worker runs." },
  { method: "POST", path: "/api/v1/actions/{agent}", scope: "Settings", what: "Starts an agent. Answers 202: accepted, not performed. The only thing this API can make happen." },
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
  const active = tokens.filter((token) => token.active);
  // A live key nothing has ever called is either not wired up yet or was a
  // mistake. Either way it is worth a second look, which is why it gets a tile.
  const neverUsed = active.filter((token) => token.lastUsedAt === null);
  const lastUsed = tokens
    .map((token) => token.lastUsedAt)
    .filter((at): at is Date => at !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  return (
    <>
      <PageHeader
        wide
        title="API tokens"
        description="Keys for things outside LaunchOS that need to read it — Mr. Green first."
        category="automation"
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Active"
          value={active.length}
          hint={active.length === 0 ? "Nothing can reach the API" : "Keys that work right now"}
          category="automation"
          icon={KeyRound}
        />
        <StatCard
          label="Never used"
          value={neverUsed.length}
          hint={neverUsed.length === 0 ? "Every key has been used" : "Issued and never called — revoke if it was a mistake"}
          category="automation"
          icon={Clock}
          attention={neverUsed.length > 0}
          attentionTone="warning"
        />
        <StatCard
          label="Last call"
          value={lastUsed ? formatDateTime(lastUsed) : "Never"}
          hint="Most recent request by any token"
          category="automation"
          icon={Activity}
        />
        <StatCard
          label="Revoked or expired"
          value={tokens.length - active.length}
          hint="Kept listed so you can see what you have dealt with"
          category="overview"
          icon={ShieldOff}
        />
      </div>

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

      <Section
        title="What a token can reach"
        description="Send it as a bearer. Everything here is a read except the last one."
      >
        <DataList
          rows={ENDPOINTS}
          columns={[
            {
              key: "path",
              header: "Endpoint",
              primary: true,
              cell: (row) => (
                <span className="font-mono text-meta break-all">
                  <span className={row.method === "POST" ? "text-warning-fg" : "text-muted-foreground"}>{row.method}</span>{" "}
                  {row.path}
                </span>
              ),
            },
            { key: "what", header: "What it answers", cell: (row) => row.what, className: "text-left" },
            { key: "scope", header: "Needs", cell: (row) => row.scope, status: true },
          ]}
          getRowKey={(row) => `${row.method} ${row.path}`}
          caption="API endpoints and the permission each needs"
        />
        <div className="mt-4 space-y-2 rounded-[20px] border bg-card p-5">
          <p className="font-mono text-sm break-all">curl {appUrl}/api/v1/brief \</p>
          <p className="font-mono text-sm break-all text-muted-foreground">
            {"  "}-H &quot;Authorization: Bearer los_…&quot;
          </p>
          <p className="text-sm text-muted-foreground">
            A reply names any section the token was not scoped to read, so nothing it could not see is
            mistaken for nothing happening.
          </p>
        </div>
      </Section>

    </>
  );
}
