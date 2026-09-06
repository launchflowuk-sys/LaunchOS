import { getClient, listClients, type MergePreview, mergePreview, MergeRefused } from "@launchos/core";
import { Users } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { requireAdminWith } from "@/lib/permissions";
import { uuidOr404 } from "@/lib/uuid-route";
import { KeepClientPicker } from "./keep-picker";
import { MergeForm } from "./merge-form";
import { describeCounts } from "./merge-words";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ClientRecord = NonNullable<Awaited<ReturnType<typeof getClient>>>;

/**
 * Two clients for one business become one. Step one picks the client to
 * keep (`?keep=` carries it); step two shows core's preview — what moves,
 * what stays, what is dropped, and the warnings — and takes the typed name.
 * Gated on `settings`, like the action: the merge rewrites every table that
 * names a client.
 */
export default async function MergeClientPage({ params, searchParams }: PageProps<"/clients/[id]/merge">) {
  const mergeId = uuidOr404((await params).id);
  const query = await searchParams;
  const session = await requireAdminWith("settings");
  const db = getDb();

  const client = await getClient(db, session.organisationId, mergeId);
  if (!client) notFound();
  const keepId = typeof query.keep === "string" && UUID.test(query.keep) ? query.keep : null;

  const back = (
    <Button asChild variant="secondary">
      <Link href={`/clients/${client.id}`}>Back to {client.name}</Link>
    </Button>
  );

  if (!keepId) {
    const book = await listClients(db, session.organisationId, { status: "active", limit: 200 });
    const candidates = book.filter((c) => c.id !== client.id).map((c) => ({ id: c.id, name: c.name, email: c.email }));
    return (
      <>
        <PageHeader
          title={`Merge ${client.name}`}
          description="Choose the client that stays. Everything on this record moves to it, and this record is archived."
          category="delivery"
          actions={back}
        />
        <Section title="Client to keep" description="Only live clients are offered — a merge into an archived client is refused.">
          {candidates.length === 0 ? (
            <EmptyState icon={Users}>There is no other active client to merge into.</EmptyState>
          ) : (
            <div className="rounded-xl border bg-card p-4">
              <KeepClientPicker clients={candidates} />
            </div>
          )}
        </Section>
      </>
    );
  }

  let preview: MergePreview;
  try {
    preview = await mergePreview(db, session.organisationId, { keepId, mergeId: client.id });
  } catch (error) {
    if (!(error instanceof MergeRefused)) throw error;
    return (
      <>
        <PageHeader title={`Merge ${client.name}`} description="That merge cannot go ahead." category="delivery" actions={back} />
        <InlineAlert
          tone="danger"
          title="Merge refused"
          action={<Button asChild variant="secondary"><Link href={`/clients/${client.id}/merge`}>Pick another client</Link></Button>}
        >
          {error.message}
        </InlineAlert>
      </>
    );
  }

  return <ConfirmScreen client={client} preview={preview} back={back} />;
}

/** One side of the merge: a card, not a Section, so the two sit level in a grid. */
function Party({ heading, description, party }: { heading: string; description: string; party: MergePreview["keep"] }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <h2 className="text-base font-semibold">{heading}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      <KeyValue
        className="mt-4"
        items={[
          { label: "Name", value: <Link href={`/clients/${party.id}`} className="font-medium text-primary hover:underline">{party.name}</Link> },
          { label: "Email", value: party.email ?? "—" },
          { label: "Support address", value: party.supportEmail ?? "—" },
          { label: "Status", value: <StatusBadge value={party.status} /> },
        ]}
      />
    </div>
  );
}

function CountLine({ heading, counts, nothing }: { heading: string; counts: Readonly<Record<string, number>>; nothing: string }) {
  const words = describeCounts(counts);
  return (
    <div className="min-w-0">
      <dt className="label-caps text-muted-foreground">{heading}</dt>
      <dd className="mt-1 text-sm break-words">{words || <span className="text-muted-foreground">{nothing}</span>}</dd>
    </div>
  );
}

function ConfirmScreen({ client, preview, back }: { client: ClientRecord; preview: MergePreview; back: ReactNode }) {
  const moved = describeCounts(preview.moved);
  return (
    <>
      <PageHeader
        title={`Merge ${preview.merge.name} into ${preview.keep.name}`}
        description="Check what moves, then type the kept client's name. This cannot be undone."
        category="delivery"
        actions={back}
      />

      <Section>
        <div className="grid gap-4 md:grid-cols-2">
          <Party heading="Keep" description="The record that survives. Its empty details are filled from the other one." party={preview.keep} />
          <Party heading="Merge away" description="Archived once its records have moved, with a note of where they went." party={preview.merge} />
        </div>
      </Section>

      <Section title="What happens" description="Counted now, from the records as they stand.">
        <dl className="grid gap-4 rounded-xl border bg-card p-4 sm:grid-cols-3">
          <CountLine heading="Moves to the kept client" counts={preview.moved} nothing="Nothing — the duplicate has no records of its own." />
          <CountLine heading="Stays on the archived client" counts={preview.left} nothing="Nothing." />
          <CountLine heading="Dropped" counts={preview.dropped} nothing="Nothing." />
        </dl>
        {preview.warnings.length > 0 ? (
          <InlineAlert tone="warning" title="Worth knowing" className="mt-4">
            <ul className="list-disc space-y-1 pl-5">
              {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          </InlineAlert>
        ) : null}
      </Section>

      <Section title="Confirm" description={`Everything above moves to ${preview.keep.name}; ${client.name} is archived.`}>
        <div className="rounded-xl border bg-card p-4">
          <MergeForm keepId={preview.keep.id} keepName={preview.keep.name} mergeId={client.id} mergeName={client.name} movedSummary={moved} />
        </div>
      </Section>
    </>
  );
}
