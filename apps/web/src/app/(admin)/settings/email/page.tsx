import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { sendTestEmail } from "./actions";

export const dynamic = "force-dynamic";

function EnvRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-neutral-100 px-4 py-2 text-sm last:border-0">
      <span className="text-neutral-500">{label}</span>
      <span className="truncate font-mono text-neutral-900">{value}</span>
    </div>
  );
}

export default async function EmailSettingsPage() {
  const session = await requireAdmin();

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
      <PageHeader title="Email" description="Inbound support routing and the outbound email adapter." />

      <div className="mb-6 overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <EnvRow label="Support email domain" value={process.env.SUPPORT_EMAIL_DOMAIN || "Not set"} />
        <EnvRow label="Inbound provider" value={process.env.INBOUND_EMAIL_PROVIDER || "Not set"} />
        <EnvRow label="Outbound adapter" value={emailAdapter} />
        <EnvRow label="Mail from" value={process.env.MAIL_FROM || "Not set"} />
        <EnvRow label="Owner notify email" value={ownerNotifyEmail || "Not set"} />
        <EnvRow label="Storage directory" value={process.env.STORAGE_DIR || "Not set"} />
        <EnvRow label="Inbound webhook secret" value={process.env.INBOUND_EMAIL_SECRET ? "Set" : "Not set"} />
      </div>

      <div className="mb-6 rounded-lg border border-neutral-200 bg-white p-4">
        <p className="text-sm font-medium text-neutral-900">Webhook URL for the inbound provider</p>
        <p className="mt-1 break-all font-mono text-sm text-neutral-600">{webhookUrl}</p>
        <p className="mt-2 text-sm text-neutral-500">
          Send the shared secret in the <code className="font-mono">x-launchos-inbound-secret</code> header.
        </p>
      </div>

      <p className="mb-2 text-sm font-medium text-neutral-900">Client support addresses</p>
      {rows.length === 0 ? (
        <EmptyState>No client support addresses yet — they are created automatically when a client is added.</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>Display name</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.address}>
                <TableCell>{row.clientName}</TableCell>
                <TableCell className="font-mono">{row.address}</TableCell>
                <TableCell>{row.displayName ?? "—"}</TableCell>
                <TableCell>{formatDateTime(row.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="mt-6 rounded-lg border border-neutral-200 bg-white p-4">
        <p className="text-sm font-medium text-neutral-900">Send a test email</p>
        <p className="mt-1 text-sm text-neutral-500">
          Sends via the {emailAdapter} adapter to the owner notification address, bypassing the approval gate.
        </p>
        <form action={sendTestEmail} className="mt-3">
          <Button type="submit" disabled={!ownerNotifyEmail}>
            Send test email to owner
          </Button>
        </form>
        {!ownerNotifyEmail ? (
          <div className="mt-3">
            <EmptyState>Set OWNER_NOTIFY_EMAIL to enable this.</EmptyState>
          </div>
        ) : null}
      </div>
    </>
  );
}
