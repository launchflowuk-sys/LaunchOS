import { type DocumentKind, type DocumentRow, listDocuments, signedDocumentUrl } from "@launchos/core";
import { FolderOpen } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDate } from "@/lib/format";
import { requireClient } from "@/lib/portal-session";

export const dynamic = "force-dynamic";

/**
 * Every document this client has, in one place.
 *
 * The workflow page promises "PDFs they can keep", and this is where they are
 * kept: proposals, the signed copies, the handover report, invoices and the
 * monthly account report — one list, newest first, each through its own
 * signed, expiring link.
 *
 * **A filing cabinet, not a feed.** Nothing here is a highlight, an update or
 * a thing that happened; it is a set of files with names and dates, and a
 * drawer per kind so somebody looking for last March's invoice can find it
 * without reading anything. Boring is the specification.
 *
 * The links are `signedDocumentUrl` rather than bare `/api/documents/<id>`,
 * which the portal session would also open: the signed link is the same one
 * the email carried, so the copy they open here is the copy they were sent,
 * and it is minted per render so a page left open overnight still works in the
 * morning.
 */

/** Newest first; a client of ten years does not need all of them at once. */
const LIST_LIMIT = 200;

/** The client's words for each kind. `documents.kind` is ours. */
const KIND_LABEL: Record<DocumentKind, string> = {
  proposal: "Proposal",
  proposal_signed: "Signed proposal",
  delivery_report: "Handover",
  invoice: "Invoice",
  monthly_report: "Monthly report",
  other: "Other",
};

/** The order the drawers sit in: the order the work happens in. */
const KIND_ORDER: readonly DocumentKind[] = [
  "proposal",
  "proposal_signed",
  "delivery_report",
  "invoice",
  "monthly_report",
  "other",
];

/** "142 KB". Whole numbers: nobody has ever needed 1.37 MB of invoice. */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${Math.round(kb)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

type Row = { document: DocumentRow; href: string };

const COLUMNS: readonly DataListColumn<Row>[] = [
  {
    key: "title",
    header: "Document",
    primary: true,
    cell: ({ document }) => (
      <>
        {document.title}
        <span className="block font-mono text-meta font-normal text-muted-foreground">{document.reference}</span>
      </>
    ),
  },
  { key: "kind", header: "Type", cell: ({ document }) => KIND_LABEL[document.kind] },
  {
    key: "dated",
    header: "Dated",
    className: "whitespace-nowrap",
    cell: ({ document }) => formatDate(document.createdAt),
  },
  {
    key: "size",
    header: "Size",
    numeric: true,
    hideOnMobile: true,
    cell: ({ document }) => fileSize(document.sizeBytes),
  },
  {
    key: "open",
    header: "Open",
    action: true,
    cell: ({ href }) => (
      <Button asChild variant="secondary" size="sm">
        <a href={href}>Open the PDF</a>
      </Button>
    ),
  },
];

export default async function PortalDocumentsPage({ searchParams }: PageProps<"/portal/documents">) {
  const session = await requireClient();
  const params = await searchParams;
  const kindParam = typeof params.kind === "string" ? params.kind : "all";
  const kind = KIND_ORDER.find((value) => value === kindParam) ?? null;

  // One read for the cabinet, filtered in the page rather than the query so
  // the drawer counts are the counts of what is actually filed.
  const documents = await listDocuments(getDb(), session.organisationId, {
    clientId: session.clientId,
    limit: LIST_LIMIT,
  });

  const counts = new Map<DocumentKind, number>();
  for (const document of documents) counts.set(document.kind, (counts.get(document.kind) ?? 0) + 1);
  const drawers = KIND_ORDER.filter((value) => (counts.get(value) ?? 0) > 0);

  const rows: Row[] = documents
    .filter((document) => kind === null || document.kind === kind)
    .map((document) => ({
      document,
      href: signedDocumentUrl({ organisationId: session.organisationId, documentId: document.id }),
    }));

  return (
    <>
      <PageHeader
        title="Documents"
        description="Every PDF we have sent you — proposals, your handover, invoices and monthly reports. They are yours to keep."
        category="delivery"
      />

      {drawers.length > 1 ? (
        <ul className="mb-4 flex flex-wrap gap-2" aria-label="Documents by kind">
          {[null, ...drawers].map((value) => (
            <li key={value ?? "all"}>
              <Link
                href={value === null ? { pathname: "/portal/documents" } : { pathname: "/portal/documents", query: { kind: value } }}
                aria-current={kind === value ? "page" : undefined}
                className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm transition-colors hover:bg-muted aria-[current=page]:border-primary aria-[current=page]:bg-primary-soft"
              >
                <span>{value === null ? "Everything" : KIND_LABEL[value]}</span>
                <span className="font-semibold tabular-nums">
                  {value === null ? documents.length : (counts.get(value) ?? 0)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={({ document }) => document.id}
        caption="Your documents"
        empty={
          <EmptyState icon={FolderOpen}>
            {kind === null
              ? "Nothing filed yet. Every proposal, handover report, invoice and monthly report we send you lands on this page, and stays here."
              : `No ${KIND_LABEL[kind].toLowerCase()}s yet.`}
          </EmptyState>
        }
      />

      {documents.length === LIST_LIMIT ? (
        <p className="mt-3 text-meta text-muted-foreground">
          Showing the {LIST_LIMIT} most recent documents. Ask us if you need an older one.
        </p>
      ) : null}
    </>
  );
}
