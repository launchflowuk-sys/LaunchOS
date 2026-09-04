import { supportEmailDomain } from "@launchos/core";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function OrganisationSettingsPage() {
  const session = await requireAdmin();
  const [organisation] = await getDb()
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.id, session.organisationId));
  if (!organisation) notFound();

  return (
    <>
      <PageHeader title="Organisation" description="Who this LaunchOS runs for, and where client mail lands." />

      <dl className="grid grid-cols-1 gap-4 rounded-lg border border-neutral-200 bg-white p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Name</dt>
          <dd className="mt-1 text-neutral-900">{organisation.name}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Slug</dt>
          <dd className="mt-1 text-neutral-700">{organisation.slug}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Status</dt>
          <dd className="mt-1">
            <StatusBadge value={organisation.status} />
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Created</dt>
          <dd className="mt-1 text-neutral-700">{formatDateTime(organisation.createdAt)}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs uppercase tracking-wide text-neutral-400">Support email domain</dt>
          <dd className="mt-1 text-neutral-900">
            <code className="rounded bg-neutral-100 px-1.5 py-0.5">{supportEmailDomain()}</code>
            <span className="ml-2 text-xs text-neutral-500">
              Every client address is <code>slug@{supportEmailDomain()}</code>. Change it with the{" "}
              <code>SUPPORT_EMAIL_DOMAIN</code> environment variable; inbound routing arrives in Plan 4.
            </span>
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-sm text-neutral-500">
        Agent enablement lives on{" "}
        <Link href="/settings/agents" className="underline">
          Settings → Agents
        </Link>
        .
      </p>
    </>
  );
}
