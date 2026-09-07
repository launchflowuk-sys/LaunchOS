import { type CaseStudyRow, listCaseStudies } from "@launchos/core";
import type { CaseStudyKind, CaseStudyStatus } from "@launchos/db/schema";
import { Star, Trophy } from "lucide-react";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { FilterBar, ToolbarActions, ToolbarField } from "@/components/toolbar";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/lib/db";
import { requireAdminWith } from "@/lib/permissions";
import { setCaseStudyStatusAction, setFeaturedAction } from "./actions";
import { CaseStudyStatusBadge, DeliveryStatusBadge } from "./case-study-status-badge";
import { ReorderControls } from "./reorder-controls";
import { CASE_STUDY_STATUS_LABEL, CASE_STUDY_STATUSES, KIND_LABEL } from "./schemas";

export const dynamic = "force-dynamic";

const KIND_FILTERS = ["all", "client", "product"] as const;
type KindFilter = (typeof KIND_FILTERS)[number];
const STATUS_FILTERS = ["all", ...CASE_STUDY_STATUSES] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** The list rows carry the whole ordered id list, because reorder sends all of it. */
type Row = { study: CaseStudyRow; index: number; ids: readonly string[] };

const COLUMNS: readonly DataListColumn<Row>[] = [
  {
    key: "name",
    header: "Story",
    primary: true,
    cell: ({ study }) => (
      <>
        <Link href={`/case-studies/${study.id}`} className="hover:underline">
          {study.name}
        </Link>
        <span className="block font-mono text-meta font-normal text-muted-foreground">/work/{study.slug}</span>
      </>
    ),
  },
  { key: "status", header: "Status", status: true, cell: ({ study }) => <CaseStudyStatusBadge status={study.status} /> },
  { key: "kind", header: "Kind", hideOnMobile: true, cell: ({ study }) => KIND_LABEL[study.kind] },
  { key: "delivery", header: "Build", cell: ({ study }) => <DeliveryStatusBadge status={study.deliveryStatus} /> },
  {
    key: "featured",
    header: "On the home page",
    cell: ({ study }) => (
      <ActionForm action={setFeaturedAction} success={study.featured ? "Taken off the home page" : "Added to the home page"}>
        <input type="hidden" name="caseStudyId" value={study.id} />
        <input type="hidden" name="featured" value={study.featured ? "false" : "true"} />
        <Button type="submit" variant="ghost" size="sm" className="max-sm:w-full">
          <Star aria-hidden className={study.featured ? "fill-warning-fg text-warning-fg" : ""} />
          {study.featured ? "Featured" : "Not featured"}
        </Button>
      </ActionForm>
    ),
  },
  {
    key: "publish",
    header: "Publish",
    cell: ({ study }) => (
      <ActionForm action={setCaseStudyStatusAction} success={study.status === "published" ? "Taken down" : "Published"}>
        <input type="hidden" name="caseStudyId" value={study.id} />
        <input type="hidden" name="status" value={study.status === "published" ? "draft" : "published"} />
        <Button type="submit" variant={study.status === "published" ? "destructive-quiet" : "secondary"} size="sm" className="max-sm:w-full">
          {study.status === "published" ? "Unpublish" : "Publish"}
        </Button>
      </ActionForm>
    ),
  },
  {
    key: "order",
    header: "Order",
    // A plain column, not `action: true`: the card's action slot stretches
    // every button inside it to full width, and two full-width icon buttons
    // side by side push the page sideways. As a column the pair sits at the
    // right of an "Order" row on a phone and in a right-aligned cell at `md+`.
    numeric: true,
    className: "whitespace-nowrap",
    cell: ({ ids, index }) => <ReorderControls ids={ids} index={index} />,
  },
];

export default async function CaseStudiesPage({ searchParams }: PageProps<"/case-studies">) {
  const session = await requireAdminWith("content");
  const params = await searchParams;
  const kindParam = typeof params.kind === "string" ? params.kind : "all";
  const statusParam = typeof params.status === "string" ? params.status : "all";
  const kind: KindFilter = KIND_FILTERS.includes(kindParam as KindFilter) ? (kindParam as KindFilter) : "all";
  const status: StatusFilter = STATUS_FILTERS.includes(statusParam as StatusFilter) ? (statusParam as StatusFilter) : "all";

  // The full list in page order, whatever the filter: reorder writes positions
  // from the ids it is given, and reordering a filtered view would push
  // everything that was filtered out to the bottom of the Work page.
  const all = await listCaseStudies(getDb(), session.organisationId, { limit: 500 });
  const ids = all.map((study) => study.id);
  const shown = all.filter(
    (study) => (kind === "all" || study.kind === (kind as CaseStudyKind)) && (status === "all" || study.status === (status as CaseStudyStatus)),
  );
  const rows: Row[] = shown.map((study) => ({ study, index: ids.indexOf(study.id), ids }));
  const published = all.filter((study) => study.status === "published").length;
  const featured = all.filter((study) => study.featured && study.status === "published").length;

  return (
    <>
      <PageHeader
        title="Case studies"
        description="The public portfolio. What is published here is what launchflow.co.uk shows, in this order."
        category="delivery"
      />

      <p className="mb-4 text-sm text-muted-foreground">
        {published} of {all.length} published · {featured} marked for the home page
        {featured > 4 ? ", which shows the first four in this order" : ""}.{" "}
        <Link href="/site/work" className="font-medium text-primary hover:underline">
          See the Work page
        </Link>
        .
      </p>

      <form action="/case-studies">
        <FilterBar>
          <ToolbarField label="Kind" htmlFor="kind" className="sm:w-48">
            <NativeSelect key={kind} id="kind" name="kind" defaultValue={kind}>
              {KIND_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All" : KIND_LABEL[option as CaseStudyKind]}
                </option>
              ))}
            </NativeSelect>
          </ToolbarField>
          <ToolbarField label="Status" htmlFor="status" className="sm:w-48">
            <NativeSelect key={status} id="status" name="status" defaultValue={status}>
              {STATUS_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "All" : CASE_STUDY_STATUS_LABEL[option]}
                </option>
              ))}
            </NativeSelect>
          </ToolbarField>
          <ToolbarActions>
            <Button type="submit" variant="secondary">
              Apply
            </Button>
          </ToolbarActions>
        </FilterBar>
      </form>

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={({ study }) => study.id}
        caption="Case studies"
        empty={
          <EmptyState icon={Trophy}>
            {all.length === 0
              ? "No stories yet. Every project starts one as a draft, and delivering the project opens it for writing."
              : "Nothing matches that filter."}
          </EmptyState>
        }
      />

      <Section title="How a story gets here" description="Nothing on this page is typed twice.">
        <ul className="grid gap-2 text-sm text-muted-foreground">
          <li>A new project opens a draft story with the client&rsquo;s name and the summary already in it.</li>
          <li>Delivering the project moves the build to live and leaves the story a draft — delivery is when it becomes writable, not public.</li>
          <li>The Case Study Writer drafts the copy from the brief, the milestones and the screenshots. Publishing is yours.</li>
        </ul>
      </Section>
    </>
  );
}
