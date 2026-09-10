import { emailHealth } from "@launchos/core";
import { ActionForm } from "@/components/action-form";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { AtSign, Inbox, Send, TriangleAlert, Users, Clock } from "lucide-react";
import type { ReactNode } from "react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { sendTestEmail } from "./actions";

export const dynamic = "force-dynamic";

/** Seven days: a week of traffic is enough to tell "quiet" from "broken". */
const WINDOW_DAYS = 7;

type Row = {
  clientName: string;
  address: string;
  displayName: string | null;
  createdAt: Date;
};

const COLUMNS: readonly DataListColumn<Row>[] = [
  { key: "client", header: "Client", primary: true, cell: (row) => row.clientName },
  { key: "address", header: "Address", className: "font-mono text-meta break-all", cell: (row) => row.address },
  { key: "displayName", header: "Display name", cell: (row) => row.displayName ?? "—" },
  {
    key: "created",
    header: "Created",
    className: "whitespace-nowrap",
    cell: (row) => formatDateTime(row.createdAt),
  },
];

/** An env value that is set reads as itself; one that is not says so in words. */
function envValue(value: string | undefined): ReactNode {
  return value ? (
    <span className="font-mono break-all">{value}</span>
  ) : (
    <span className="text-muted-foreground">Not set</span>
  );
}

export default async function EmailSettingsPage() {
  const session = await requireAdmin();

  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const health = await emailHealth(getDb(), session.organisationId, since, now);

  const rows = await getDb()
    .select({
      clientName: schema.clients.name,
      address: schema.emailIdentities.address,
      displayName: schema.emailIdentities.displayName,
      createdAt: schema.emailIdentities.createdAt,
    })
    .from(schema.emailIdentities)
    .innerJoin(schema.clients, eq(schema.emailIdentities.clientId, schema.clients.id))
    .where(eq(schema.emailIdentities.organisationId, session.organisationId));

  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const webhookUrl = `${appUrl}/api/webhooks/email/inbound`;
  const ownerNotifyEmail = process.env.OWNER_NOTIFY_EMAIL;
  const emailAdapter = process.env.EMAIL_ADAPTER ?? "mock";

  return (
    <>
      <PageHeader
        wide
        title="Email"
        description="Inbound support routing and the outbound email adapter."
        category="automation"
      />

      {/* The screen used to open with configuration, which nobody reads twice.
          What it owes a person opening it is whether the mail is moving — and
          in particular whether a reply to a client failed or is stuck, because
          neither is visible anywhere else until the client chases. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Received"
          value={health.received}
          hint={`Inbound, last ${WINDOW_DAYS} days`}
          category="support"
          icon={Inbox}
        />
        <StatCard
          label="Sent"
          value={health.sent}
          hint={`Outbound, last ${WINDOW_DAYS} days`}
          category="support"
          icon={Send}
        />
        <StatCard
          label="Failed"
          value={health.failed}
          hint={health.failed === 0 ? "Nothing rejected" : "Never left. All time."}
          category="support"
          icon={TriangleAlert}
          attention={health.failed > 0}
        />
        <StatCard
          label="Stuck in the queue"
          value={health.stuck}
          hint={health.stuck === 0 ? "Queue is moving" : "Waiting over 15 minutes — check the worker"}
          category="automation"
          icon={Clock}
          attention={health.stuck > 0}
        />
        <StatCard
          label="Clients routed"
          value={`${health.routed} of ${health.clients}`}
          hint={
            health.routed >= health.clients
              ? "Every active client has an address"
              : `${health.clients - health.routed} without a support address`
          }
          category="delivery"
          icon={Users}
          attention={health.routed < health.clients}
          attentionTone="warning"
        />
      </div>

      <Section title="Configuration" description="Read from the environment at request time.">
        <div className="rounded-[20px] border bg-card p-5">
          <KeyValue
            columns={2}
            items={[
              { label: "Support email domain", value: envValue(process.env.SUPPORT_EMAIL_DOMAIN) },
              { label: "Inbound provider", value: envValue(process.env.INBOUND_EMAIL_PROVIDER) },
              { label: "Outbound adapter", value: envValue(emailAdapter) },
              { label: "Mail from", value: envValue(process.env.MAIL_FROM) },
              { label: "Owner notify email", value: envValue(ownerNotifyEmail) },
              { label: "Storage directory", value: envValue(process.env.STORAGE_DIR) },
              {
                label: "Inbound webhook secret",
                value: envValue(process.env.INBOUND_EMAIL_SECRET ? "Set" : undefined),
              },
            ]}
          />
        </div>
      </Section>

      <Section title="Inbound webhook" description="Point the inbound provider at this URL.">
        <div className="rounded-[20px] border bg-card p-5">
          <p className="font-mono text-sm break-all">{webhookUrl}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Send the shared secret in the <code className="font-mono">x-launchos-inbound-secret</code> header.
          </p>
        </div>
      </Section>

      <Section title="Client support addresses">
        <DataList
          rows={rows}
          columns={COLUMNS}
          getRowKey={(row) => row.address}
          caption="Client support addresses"
          empty={
            <EmptyState icon={AtSign}>
              No client support addresses yet — they are created automatically when a client is added.
            </EmptyState>
          }
        />
      </Section>

      <Section title="Send a test email">
        <div className="space-y-3 rounded-[20px] border bg-card p-5">
          <p className="text-sm text-muted-foreground">
            Sends via the {emailAdapter} adapter to the owner notification address, bypassing the approval gate.
          </p>
          {ownerNotifyEmail ? null : (
            <InlineAlert tone="warning">Set OWNER_NOTIFY_EMAIL to enable this.</InlineAlert>
          )}
          {/* ActionForm, not a bare form: it disables the button while the
              send is in flight and shows what came back. A plain submit gave no
              sign it had been pressed, which on a slow SMTP handshake reads as
              a dead button. */}
          <ActionForm action={sendTestEmail} ariaLabel="Send a test email" success="Test email sent">
            <Button type="submit" disabled={!ownerNotifyEmail} className="max-sm:w-full">
              Send test email to owner
            </Button>
          </ActionForm>
        </div>
      </Section>
    </>
  );
}
