import {
  type ContentItemListRow, getClient, getClientBrand, getContentBrief, listContentAssets, listContentChannels,
  listContentItems, listSites, monthName, periodKeyFor,
} from "@launchos/core";
import { hasGbpCredentials, hasMetaSocialCredentials } from "@launchos/integrations";
import { Newspaper } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { requireAdmin } from "@/lib/session";
import { uuidOr404 } from "@/lib/uuid-route";
import { briefImageMode } from "../../../content/image-meta";
import { ChannelLabel, ContentStatusBadge, KIND_LABEL } from "../../../content/presentation";
import { ClientTabs } from "../tabs";
import { AssetLibrary } from "./asset-library";
import { BrandForm } from "./brand-form";
import { BriefForm } from "./brief-form";
import { ChannelsForm } from "./channels-form";

export const dynamic = "force-dynamic";

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
        <span className="block text-meta font-normal text-muted-foreground">{KIND_LABEL[item.kind]}</span>
      </>
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
];

export default async function ClientContentPage({ params }: PageProps<"/clients/[id]/content">) {
  const session = await requireAdmin();
  const id = uuidOr404((await params).id);
  const db = getDb();

  const client = await getClient(db, session.organisationId, id);
  if (!client) notFound();

  const period = periodKeyFor(new Date());
  const [{ items }, brief, channels, sites, assets, brand] = await Promise.all([
    listContentItems(db, session.organisationId, { clientId: id, periodKey: period, sort: "scheduled", limit: 100 }),
    getContentBrief(db, session.organisationId, { clientId: id }),
    listContentChannels(db, session.organisationId, { clientId: id }),
    listSites(db, session.organisationId, { clientId: id }),
    listContentAssets(db, session.organisationId, { clientId: id }),
    getClientBrand(db, session.organisationId, { clientId: id }),
  ]);

  const allHref = { pathname: "/content", query: { period, client: id } } as const;
  // The wordmark falls back to the trading name, so the box shows a choice
  // actually made and nothing else — leaving it blank keeps a later rename
  // flowing through to the graphics on its own.
  const wordmarkFallback = client.tradingName ?? client.name;

  return (
    <>
      <PageHeader
        title={client.name}
        description="What we publish for this client, the brief the writer works from, and where it goes."
        category="delivery"
        actions={
          <Button asChild variant="secondary">
            <Link href={allHref}>Open in Content</Link>
          </Button>
        }
      />

      <ClientTabs clientId={client.id} active="content" />

      <Section
        title={`This month — ${monthName(period)}`}
        description="Every slot in the month. Plan, draft and approve from the Content screen."
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={allHref}>See all</Link>
          </Button>
        }
      >
        <DataList
          rows={items}
          columns={COLUMNS}
          getRowKey={(item) => item.id}
          caption={`Content for ${client.name}, ${monthName(period)}`}
          empty={
            <EmptyState
              icon={Newspaper}
              action={
                <Button asChild variant="secondary">
                  <Link href={allHref}>Plan the month</Link>
                </Button>
              }
            >
              Nothing planned for {monthName(period)} yet. Plan the month from the package on the Content screen.
            </EmptyState>
          }
        />
      </Section>

      <Section
        title="Brief"
        description="What the content writer knows about this client. It reads this and the knowledge base before every draft, and never invents an offer that is not here."
      >
        <BriefForm clientId={client.id} brief={brief} />
      </Section>

      <Section
        title="Brand and post images"
        description="The colours and name a branded graphic is drawn in, and whether this client's posts get graphics or generated photographs. Used by every image we draw for them."
      >
        <BrandForm
          clientId={client.id}
          primary={brand.primary}
          accent={brand.accent}
          wordmark={brand.wordmark === wordmarkFallback ? "" : brand.wordmark}
          wordmarkFallback={wordmarkFallback}
          imageMode={briefImageMode(brief?.metadata)}
        />
      </Section>

      <Section
        title="Image library"
        description="Photos for this client's posts. The writer picks from these — it never invents an image — and the client can add their own from the portal. Posts with photos do far better."
      >
        <AssetLibrary logoAssetId={brand.logoAssetId} clientId={client.id} assets={assets} />
      </Section>

      <Section
        title="Channels"
        description="Where approved posts go. A slot for a channel that is not connected fails at publish time with a message saying so."
      >
        <ChannelsForm
          clientId={client.id}
          channels={channels}
          sites={sites}
          metaConfigured={hasMetaSocialCredentials(process.env)}
          gbpConfigured={hasGbpCredentials(process.env)}
        />
      </Section>
    </>
  );
}
