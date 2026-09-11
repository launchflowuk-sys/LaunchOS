import {
  type ClientServiceState, getClient, listActiveSubscriptionsForClient, listClientServices, SERVICE_LABEL, servicesPaidFor,
} from "@launchos/core";
import { schema } from "@launchos/db";
import type { ClientService, PackageIncludes } from "@launchos/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { InlineAlert } from "@/components/inline-alert";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { ClientTabs } from "../tabs";
import { setClientServiceAction } from "./actions";

export const dynamic = "force-dynamic";

/** What switching a service on actually starts. Said plainly, because it is what the switch costs. */
const WHAT_IT_RUNS: Readonly<Record<ClientService, string>> = {
  ads: "Daily Google and Meta figures, the Ad Sentinel's checks and draft reports, and cost per lead.",
  blog: "Blog posts planned each month from the package, written by the Content Writer and published to their site.",
  social: "Facebook and Instagram posts planned, written and published, and shares of their new blog posts.",
  gbp: "Google Business Profile updates planned, written and published, and shares of their new blog posts.",
};

/**
 * What the client pays for, across every live subscription and the package on
 * the client record — the union, because a client paying for ads on one
 * subscription and posts on another pays for both.
 */
async function paidServices(organisationId: string, clientId: string, clientPackageId: string | null): Promise<ReadonlySet<ClientService>> {
  const db = getDb();
  const subscriptions = await listActiveSubscriptionsForClient(db, organisationId, clientId);
  const ids = [...new Set([...subscriptions.map((s) => s.packageId), clientPackageId].filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Set();
  const rows = await db.select({ includes: schema.packages.includes }).from(schema.packages)
    .where(and(eq(schema.packages.organisationId, organisationId), inArray(schema.packages.id, ids)));
  return new Set(rows.flatMap((row) => [...servicesPaidFor(row.includes as PackageIncludes)]));
}

function lastChanged(state: ClientServiceState): string {
  if (!state.changedAt) return "Never switched on";
  const who = state.changedByName ?? "the system";
  return `Switched ${state.active ? "on" : "off"} by ${who}, ${formatDateTime(state.changedAt)}`;
}

export default async function ClientServicesPage({ params }: PageProps<"/clients/[id]/services">) {
  const session = await requireAdmin();
  const id = uuidOr404((await params).id);
  const db = getDb();

  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const [services, paid] = await Promise.all([
    listClientServices(db, session.organisationId, id),
    paidServices(session.organisationId, id, client.packageId),
  ]);
  const paidButOff = services.filter((s) => paid.has(s.service) && !s.active);
  const onButUnpaid = services.filter((s) => s.active && !paid.has(s.service));

  return (
    <>
      <PageHeader
        title={client.name}
        description="What we do for this client beyond their website. Nothing here runs until you switch it on, whatever their package says."
        category="delivery"
      />

      <ClientTabs clientId={client.id} active="services" />

      {paidButOff.length > 0 ? (
        <InlineAlert tone="warning" title="Paying for work that is switched off" className="mb-6">
          Their package includes {paidButOff.map((s) => SERVICE_LABEL[s.service].toLowerCase()).join(", ")}, and
          none of it runs until you switch it on below.
        </InlineAlert>
      ) : null}
      {onButUnpaid.length > 0 ? (
        <InlineAlert tone="info" title="Switched on without a package that includes it" className="mb-6">
          {onButUnpaid.map((s) => SERVICE_LABEL[s.service]).join(", ")} {onButUnpaid.length === 1 ? "is" : "are"} running
          although no live subscription pays for {onButUnpaid.length === 1 ? "it" : "them"}. Fine if agreed separately.
        </InlineAlert>
      ) : null}

      <Section
        title="Services"
        description="Switching a service off holds its work rather than deleting it: approved posts wait, ad figures stop updating, and switching back on carries on from there."
      >
        <ul className="grid min-w-0 gap-4">
          <li className="min-w-0 rounded-[20px] border bg-card p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <div className="min-w-0">
                <p className="text-base font-semibold">Website</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Hosting, uptime checks, domains, support and the client portal. Every client has this.
                </p>
              </div>
              <StatusBadge value="always on" tone="success" />
            </div>
          </li>

          {services.map((state) => (
            <li key={state.service} className="min-w-0 rounded-[20px] border bg-card p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-base font-semibold">
                    {SERVICE_LABEL[state.service]}
                    {paid.has(state.service) ? <StatusBadge value="in package" tone="info" /> : null}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{WHAT_IT_RUNS[state.service]}</p>
                  <p className="mt-1 text-meta text-muted-foreground">{lastChanged(state)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3 max-sm:justify-between">
                  <StatusBadge value={state.active ? "on" : "off"} tone={state.active ? "success" : "neutral"} />
                  <ActionForm
                    action={setClientServiceAction}
                    success={state.active ? `${SERVICE_LABEL[state.service]} switched off` : `${SERVICE_LABEL[state.service]} switched on`}
                    ariaLabel={`${state.active ? "Switch off" : "Switch on"} ${SERVICE_LABEL[state.service]}`}
                  >
                    <input type="hidden" name="clientId" value={client.id} />
                    <input type="hidden" name="service" value={state.service} />
                    <input type="hidden" name="active" value={state.active ? "false" : "true"} />
                    <Button type="submit" variant={state.active ? "secondary" : "primary"} size="sm">
                      {state.active ? "Switch off" : "Switch on"}
                    </Button>
                  </ActionForm>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
