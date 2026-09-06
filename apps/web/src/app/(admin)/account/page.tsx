import { listMembers, listPushSubscriptions } from "@launchos/core";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { getDb } from "@/lib/db";
import { vapidPublicKey } from "@/lib/env";
import { formatDate, formatDateTime } from "@/lib/format";
import { endpointHost } from "@/lib/push";
import { requireAdmin } from "@/lib/session";
import { ChangePasswordForm } from "./change-password-form";
import { DeviceAlerts, type DeviceRow } from "./device-alerts";

export const dynamic = "force-dynamic";

/**
 * The staff half of the portal's `/portal/account`: the one screen a signed-in
 * owner or staff member can change their own password on.
 *
 * It matters more here than it reads. Sign-up is disabled and there is no
 * self-service reset, so every staff account starts on a one-time password an
 * owner read off a dialog and sent them. Without this screen there was no path
 * off it, and `organisation_members.initial_password_set_at` — the column that
 * decides whether an owner may still re-issue over the top of that credential —
 * could never be stamped.
 */
export default async function AccountPage() {
  const session = await requireAdmin();
  const [members, subscriptions] = await Promise.all([
    listMembers(getDb(), session.organisationId),
    listPushSubscriptions(getDb(), session.organisationId, { userId: session.userId }),
  ]);
  const me = members.find((m) => m.userId === session.userId);
  // Plain data for the client component: the endpoint travels so the browser
  // can tell whether *it* is on the list; only the host is ever rendered.
  const devices: DeviceRow[] = subscriptions.map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    host: endpointHost(row.endpoint),
    userAgent: row.userAgent,
    since: formatDate(row.createdAt),
    failed: row.failedAt !== null,
  }));

  return (
    <>
      <PageHeader
        title="Account"
        description="Your own sign-in details for this organisation."
        category="organisation"
      />

      <Section title="Signed in as">
        <div className="rounded-xl border bg-card p-4 sm:p-5">
          <KeyValue
            columns={2}
            items={[
              { label: "Name", value: me?.displayName ?? me?.name ?? session.email },
              { label: "Email", value: session.email },
              { label: "Role", value: <span className="capitalize">{session.role}</span> },
            ]}
          />
        </div>
      </Section>

      <Section
        title="Password"
        {...(me?.initialPasswordSetAt
          ? { description: `You set your own password on ${formatDateTime(me.initialPasswordSetAt)}.` }
          : {})}
      >
        <div className="space-y-4 rounded-xl border bg-card p-4 sm:p-5">
          {me && me.initialPasswordSetAt === null ? (
            <InlineAlert tone="warning">
              You are still on the password you were issued. Change it here — until you do, an owner can re-issue a new
              one over the top of it from the Team screen.
            </InlineAlert>
          ) : null}
          <ChangePasswordForm />
        </div>
      </Section>

      <Section
        title="Alerts on this device"
        description="Urgent notifications as a system notification on this phone or computer. Each device is switched on from the device itself."
      >
        <DeviceAlerts vapidPublicKey={vapidPublicKey()} devices={devices} />
      </Section>
    </>
  );
}
