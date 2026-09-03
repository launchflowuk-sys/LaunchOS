import { schema } from "@launchos/db";
import { and, count, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

const OPEN_TICKET_STATUSES = ["open", "triaged", "in_progress", "waiting_client"] as const;
const UNRESOLVED_INCIDENT_STATUSES = ["open", "acknowledged"] as const;

export default async function DashboardPage() {
  const session = await requireAdmin();
  const org = session.organisationId;

  const [openIncidents, pendingApprovals, openTickets] = await Promise.all([
    getDb()
      .select({ value: count() })
      .from(schema.incidents)
      .where(
        and(
          eq(schema.incidents.organisationId, org),
          inArray(schema.incidents.status, [...UNRESOLVED_INCIDENT_STATUSES]),
        ),
      ),
    getDb()
      .select({ value: count() })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.organisationId, org), eq(schema.approvals.status, "pending"))),
    getDb()
      .select({ value: count() })
      .from(schema.tickets)
      .where(and(eq(schema.tickets.organisationId, org), inArray(schema.tickets.status, [...OPEN_TICKET_STATUSES]))),
  ]);

  const cards = [
    {
      label: "Open incidents",
      value: openIncidents[0]?.value ?? 0,
      href: "/incidents",
      hint: "Open or acknowledged",
    },
    {
      label: "Pending approvals",
      value: pendingApprovals[0]?.value ?? 0,
      href: "/approvals",
      hint: "Waiting on a human decision",
    },
    {
      label: "Open tickets",
      value: openTickets[0]?.value ?? 0,
      href: "/tickets",
      hint: "Not resolved or closed",
    },
  ];

  return (
    <>
      <div className="mb-6 border-b border-neutral-200 pb-4">
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900">Dashboard</h1>
        <p className="mt-1 text-sm text-neutral-500">What needs attention right now.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <Link key={card.label} href={card.href} className="block focus:outline-none">
            <Card className="h-full border-neutral-200 bg-white transition-colors hover:border-neutral-300">
              <CardHeader>
                <CardTitle className="text-sm font-medium text-neutral-600">{card.label}</CardTitle>
                <CardDescription className="text-xs text-neutral-400">{card.hint}</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-3xl font-semibold tabular-nums text-neutral-900">{card.value}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
