import {
  describePricing,
  getProposalDetail,
  LINE_KINDS_FOR_SHAPE,
  proposalDocumentHtml,
  proposalDocumentTitle,
  proposalPublicUrl,
  type ProposalDetail,
} from "@launchos/core";
import { schema } from "@launchos/db";
import { eq } from "drizzle-orm";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { InlineAlert } from "@/components/inline-alert";
import { KeyValue } from "@/components/key-value";
import { PageHeader } from "@/components/page-header";
import { DocumentPreview } from "@/components/document-preview";
import { ProposalTotals } from "@/components/proposal-totals";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdminWith } from "@/lib/permissions";
import { uuidOr404 } from "@/lib/uuid-route";
import { sendProposalAction } from "../actions";
import { ProposalStatusBadge } from "../proposal-status-badge";
import { SHAPE_OPTION_LABEL } from "../schemas";
import { whySendRefused } from "../send-queue";
import { StatusTrail } from "../status-trail";
import { DetailsForm } from "./details-form";
import { LineEditor } from "./line-editor";

export const dynamic = "force-dynamic";

/** Who the proposal is for, as a name and a link. Read even when they have no email. */
async function subject(detail: ProposalDetail): Promise<{ label: string; name: string; href: string } | null> {
  const { proposal } = detail;
  const db = getDb();
  if (proposal.clientId) {
    const [client] = await db.select({ name: schema.clients.name }).from(schema.clients).where(eq(schema.clients.id, proposal.clientId));
    if (client) return { label: "Client", name: client.name, href: `/clients/${proposal.clientId}` };
  }
  if (proposal.leadId) {
    const [lead] = await db.select({ name: schema.leads.name, business: schema.leads.business }).from(schema.leads).where(eq(schema.leads.id, proposal.leadId));
    if (lead) return { label: "Lead", name: lead.business ?? lead.name, href: `/leads/${proposal.leadId}` };
  }
  return null;
}

export default async function ProposalPage({ params }: PageProps<"/proposals/[id]">) {
  const session = await requireAdminWith("billing");
  const id = uuidOr404((await params).id);
  const detail = await getProposalDetail(getDb(), session.organisationId, id);
  if (!detail) notFound();

  const { proposal, lines, totals, acceptance, recipient } = detail;
  const who = await subject(detail);
  const editable = proposal.status === "draft";
  const sendRefusal = editable ? whySendRefused(detail) : null;
  const publicUrl = proposalPublicUrl(proposal);

  // The preview is the document the worker will print, built from the same
  // function, so nothing on this screen can disagree with the PDF.
  const documentHtml = proposalDocumentHtml({
    proposal,
    lines,
    totals,
    recipientName: recipient?.name ?? who?.name ?? "your business",
    ...(acceptance ? { acceptance } : {}),
  });

  return (
    <>
      <PageHeader
        title={proposal.title}
        description={`${proposal.reference} · ${SHAPE_OPTION_LABEL[proposal.pricing.shape]}${who ? ` · ${who.label}: ${who.name}` : ""}`}
        category="delivery"
        actions={
          <>
            <Button asChild variant="secondary">
              <a href={publicUrl} target="_blank" rel="noreferrer">
                View as the client <ExternalLink aria-hidden />
              </a>
            </Button>
            {editable ? (
              <ActionForm action={sendProposalAction} ariaLabel="Send proposal" success="Queued — the proposal goes out in a moment">
                <input type="hidden" name="proposalId" value={proposal.id} />
                <Button type="submit" disabled={sendRefusal !== null} className="w-full">
                  Send it
                </Button>
              </ActionForm>
            ) : null}
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ProposalStatusBadge status={proposal.status} />
        <span className="font-mono text-meta text-muted-foreground">{proposal.reference}</span>
      </div>

      {sendRefusal ? (
        <InlineAlert tone="warning" title="Not ready to send" className="mb-4">
          {sendRefusal}
        </InlineAlert>
      ) : null}

      {editable ? null : (
        <InlineAlert tone="info" title="This proposal is frozen" className="mb-4">
          It has been sent, so the wording and the price cannot change — the client is reading a document with{" "}
          {proposal.reference} printed on it. To change any of it, write another proposal.
        </InlineAlert>
      )}

      <Section title="Where it has got to">
        <StatusTrail proposal={proposal} />
      </Section>

      {acceptance ? (
        <Section title="Accepted" description="What we hold as the record of their agreement.">
          <KeyValue
            columns={2}
            items={[
              { label: "Name", value: acceptance.acceptedName },
              { label: "Email", value: acceptance.acceptedEmail },
              { label: "Accepted", value: formatDateTime(acceptance.acceptedAt) },
              { label: "From", value: acceptance.ip ?? "—", ...(acceptance.userAgent ? { hint: acceptance.userAgent } : {}) },
              {
                label: "Signed copy",
                value: acceptance.documentId ? (
                  <a href={`/api/documents/${acceptance.documentId}`} className="text-primary underline underline-offset-2">
                    Open the countersigned PDF
                  </a>
                ) : (
                  "Being prepared — the worker renders it just after acceptance."
                ),
              },
            ]}
          />
        </Section>
      ) : null}

      {/* The editor gets the wider half: it holds forms, and the preview only
          has to be readable — it is a scaled A4 page either way. */}
      <div className="mt-8 grid min-w-0 gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div className="min-w-0 space-y-8">
          <Section title="The price" description="Derived from the lines below. There is no total to type.">
            <ProposalTotals totals={totals} description={describePricing(totals)} vatNote={proposal.pricing.vatNote} />
          </Section>

          <Section title="The priced schedule" description={editable ? "Add, change and remove lines. The figures above follow." : "As it went out."}>
            <LineEditor
              proposalId={proposal.id}
              lines={lines.map((line) => ({
                id: line.id,
                kind: line.kind,
                description: line.description,
                quantity: line.quantity,
                unitPence: line.unitPence,
              }))}
              allowedKinds={LINE_KINDS_FOR_SHAPE[proposal.pricing.shape]}
              editable={editable}
            />
          </Section>

          {editable ? (
            <Section title="The words">
              <DetailsForm proposal={proposal} />
            </Section>
          ) : null}

          <Section title="Links">
            <KeyValue
              items={[
                {
                  label: "The client's link",
                  value: <span className="font-mono text-meta break-all">{publicUrl}</span>,
                  hint: "Unguessable, and it keeps working until the valid-until date passes.",
                },
                {
                  label: "The PDF they were sent",
                  value: proposal.documentId ? (
                    <a href={`/api/documents/${proposal.documentId}`} className="text-primary underline underline-offset-2">
                      Open the PDF
                    </a>
                  ) : (
                    "Rendered when it is sent."
                  ),
                },
                ...(who ? [{ label: who.label, value: <Link href={who.href} className="text-primary underline underline-offset-2">{who.name}</Link> }] : []),
                { label: "Sent to", value: recipient ? `${recipient.name} · ${recipient.email}` : "No email address on file yet" },
              ]}
            />
          </Section>
        </div>

        <div className="min-w-0">
          <Section title="The document" description="Exactly what gets printed. It updates as you edit.">
            <div className="lg:sticky lg:top-6">
              <DocumentPreview html={documentHtml} title={proposalDocumentTitle(proposal, acceptance !== null)} />
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}
