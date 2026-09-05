import { type ContentItemListRow, listClients, listContentItems, monthName, periodKeyFor } from "@launchos/core";
import type { ContentChannel, ContentStatus } from "@launchos/db/schema";
import { Newspaper } from "lucide-react";
import Link from "next/link";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { PAGE_SIZE, Pager, pageParam } from "@/components/pager";
import { Section } from "@/components/section";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { ContentFilterBar } from "./content-filters";
import { MonthPlanner } from "./month-planner";
import { ChannelLabel, ContentStatusBadge, KIND_LABEL } from "./presentation";
import { CONTENT_CHANNELS, CONTENT_STATUSES, PeriodKey } from "./schemas";

export const dynamic = "force-dynamic";

const NO_MATCH = "Nothing planned for this month yet. Choose a client above and plan the month from their package.";
const PAST_THE_END = "There are no posts on this page. Go back to a newer page.";

/** An empty GET-form field arrives as "", which means "no filter". */
const one = (v: string | string[] | undefined): string | undefined => {
  const raw = Array.isArray(v) ? v[0] : v;
  return raw && raw.length > 0 ? raw : undefined;
};

const isStatus = (v: string): v is ContentStatus => (CONTENT_STATUSES as readonly string[]).includes(v);
const isChannel = (v: string): v is ContentChannel => (CONTENT_CHANNELS as readonly string[]).includes(v);

const COLUMNS: readonly DataListColumn<ContentItemListRow>[] = [
  {
    key: "title",
    header: "Post",
    primary: true,
    className: "min-w-52",
    cell: (item) => (
      <>
        <Link href={`/content/${item.id}`} className="hover:underline">
          {item.title ?? (item.body ? item.body.slice(0, 60) : "Untitled slot")}
        </Link>
        <span className="block text-meta font-normal text-muted-foreground">
          {KIND_LABEL[item.kind]}
          {item.source === "client" ? " · suggested by the client" : ""}
        </span>
      </>
    ),
  },
  {
    key: "client",
    header: "Client",
    cell: (item) => (
      <Link href={`/clients/${item.clientId}/content`} className="hover:underline">
        {item.clientName}
      </Link>
    ),
  },
  { key: "channel", header: "Channel", cell: (item) => <ChannelLabel channel={item.channel} /> },
  {
    key: "scheduled",
    header: "Scheduled",
    className: "whitespace-nowrap",
    cell: (item) => (item.scheduledFor ? formatDateTime(item.scheduledFor) : "No date"),
  },
  { key: "status", header: "Status", status: true, cell: (item) => <ContentStatusBadge status={item.status} /> },
  {
    key: "open",
    header: "Open",
    action: true,
    cell: (item) => (
      <Link href={`/content/${item.id}`} className="text-primary underline underline-offset-2">
        Open
      </Link>
    ),
  },
];

export default async function ContentPage({ searchParams }: PageProps<"/content">) {
  const session = await requireAdmin();
  const sp = await searchParams;

  const requestedPeriod = one(sp.period);
  const period = requestedPeriod && PeriodKey.safeParse(requestedPeriod).success ? requestedPeriod : periodKeyFor(new Date());
  const client = one(sp.client);
  const statusRaw = one(sp.status);
  const channelRaw = one(sp.channel);
  const status = statusRaw && isStatus(statusRaw) ? statusRaw : undefined;
  const channel = channelRaw && isChannel(channelRaw) ? channelRaw : undefined;
  const page = pageParam(sp.page);

  const [{ items, total }, clients] = await Promise.all([
    listContentItems(getDb(), session.organisationId, {
      periodKey: period,
      sort: "scheduled",
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
      ...(client ? { clientId: client } : {}),
      ...(status ? { status: [status] } : {}),
      ...(channel ? { channel } : {}),
    }),
    listClients(getDb(), session.organisationId, { limit: 200 }),
  ]);

  const hasNext = page * PAGE_SIZE < total;
  const clientOptions = clients.map((c) => ({ value: c.id, label: c.name }));

  return (
    <>
      <PageHeader
        title="Content"
        description="Every social post, blog post and Google Business Profile update, planned a month at a time and published once approved."
        category="delivery"
      />

      <MonthPlanner clients={clientOptions} periodKey={period} clientId={client} />

      <Section title={monthName(period)} description={`${total} ${total === 1 ? "post" : "posts"} in the month, soonest first.`}>
        <ContentFilterBar clients={clientOptions} current={{ period, client, status, channel }} />
        <DataList
          rows={items}
          columns={COLUMNS}
          getRowKey={(item) => item.id}
          caption={`Content for ${monthName(period)}`}
          empty={<EmptyState icon={Newspaper}>{page > 1 ? PAST_THE_END : NO_MATCH}</EmptyState>}
        />
        {/* Outside the empty check on purpose: a page past the end has no rows
            and still needs the "Newer" link back. */}
        <Pager basePath="/content" query={{ period, client, status, channel }} page={page} hasNext={hasNext} />
      </Section>
    </>
  );
}
