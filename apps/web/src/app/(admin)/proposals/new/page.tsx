import { schema } from "@launchos/db";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import Link from "next/link";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { requireAdminWith } from "@/lib/permissions";
import { NewProposalForm, type SubjectOption } from "./new-proposal-form";

export const dynamic = "force-dynamic";

/** The default `valid_until`, matching core's `DEFAULT_VALIDITY_DAYS`. */
const VALIDITY_DAYS = 30;

/** `YYYY-MM-DD`, a month out, in the UK — the same day core would pick. */
function defaultValidUntil(): string {
  const now = new Date();
  const uk = new Date(now.toLocaleString("en-US", { timeZone: "Europe/London" }));
  uk.setDate(uk.getDate() + VALIDITY_DAYS);
  return `${uk.getFullYear()}-${String(uk.getMonth() + 1).padStart(2, "0")}-${String(uk.getDate()).padStart(2, "0")}`;
}

/**
 * Everyone a proposal can be written for: leads that have not been lost, and
 * clients that have not been archived. One list, grouped, because a proposal
 * is for exactly one of the two.
 */
async function subjectOptions(organisationId: string): Promise<SubjectOption[]> {
  const db = getDb();
  const [leads, clients] = await Promise.all([
    db.select({ id: schema.leads.id, name: schema.leads.name, business: schema.leads.business })
      .from(schema.leads)
      .where(and(eq(schema.leads.organisationId, organisationId), isNull(schema.leads.deletedAt), ne(schema.leads.status, "lost")))
      .orderBy(asc(schema.leads.name))
      .limit(500),
    db.select({ id: schema.clients.id, name: schema.clients.name })
      .from(schema.clients)
      .where(and(eq(schema.clients.organisationId, organisationId), isNull(schema.clients.deletedAt), ne(schema.clients.status, "archived")))
      .orderBy(asc(schema.clients.name))
      .limit(500),
  ]);

  return [
    ...leads.map((lead) => ({
      value: `lead:${lead.id}`,
      label: lead.business ? `${lead.business} — ${lead.name}` : lead.name,
      group: "Leads" as const,
    })),
    ...clients.map((client) => ({ value: `client:${client.id}`, label: client.name, group: "Clients" as const })),
  ];
}

export default async function NewProposalPage() {
  const session = await requireAdminWith("billing");
  const subjects = await subjectOptions(session.organisationId);

  return (
    <>
      <PageHeader
        title="New proposal"
        description="Who it is for, what it is called and how it is paid for. The priced lines come next."
        category="delivery"
        actions={
          <Button asChild variant="secondary">
            <Link href="/proposals">Back to proposals</Link>
          </Button>
        }
      />

      {subjects.length === 0 ? (
        <EmptyState
          action={
            <Button asChild>
              <Link href="/leads">Go to Leads</Link>
            </Button>
          }
        >
          There is nobody to write a proposal for yet. Add a lead, or take on a client, and come back.
        </EmptyState>
      ) : (
        <NewProposalForm subjects={subjects} defaultValidUntil={defaultValidUntil()} />
      )}
    </>
  );
}
