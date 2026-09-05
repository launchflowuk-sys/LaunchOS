import { listSites } from "@launchos/core";
import { Globe } from "lucide-react";
import { DataList, type DataListColumn } from "@/components/data-list";
import { EmptyState, PageHeader } from "@/components/page-header";
import { SiteStatusBadge } from "@/components/portal/portal-status";
import { getDb } from "@/lib/db";
import { requireClient } from "@/lib/portal-session";

/**
 * Defence in depth for a value rendered as an `href`. `createSite` already
 * refuses anything but http(s), but a row predating that check — or one written
 * straight to the table — must not become a live `javascript:` link in a
 * client's browser.
 */
function isSafeUrl(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

export const dynamic = "force-dynamic";

type SiteRow = { id: string; name: string; primaryUrl: string; platform: string; status: string };

/** The `site_platform` values, spelled the way their makers spell them. */
const PLATFORM_LABEL: Record<string, string> = {
  wordpress: "WordPress",
  static: "Static site",
  nextjs: "Next.js",
  other: "Custom build",
};

const COLUMNS: readonly DataListColumn<SiteRow>[] = [
  { key: "name", header: "Website", primary: true, cell: (row) => row.name },
  {
    key: "url",
    header: "Address",
    cell: (row) =>
      isSafeUrl(row.primaryUrl) ? (
        <a href={row.primaryUrl} target="_blank" rel="noreferrer" className="break-all hover:underline">
          {row.primaryUrl}
        </a>
      ) : (
        <span className="break-all">{row.primaryUrl}</span>
      ),
  },
  { key: "platform", header: "Built with", hideOnMobile: true, cell: (row) => PLATFORM_LABEL[row.platform] ?? row.platform },
  { key: "status", header: "Status", status: true, cell: (row) => <SiteStatusBadge value={row.status} /> },
];

export default async function PortalSitesPage() {
  const session = await requireClient();
  // `listSites` filters on the organisation; `clientId` from the session is the
  // second half of the scope. Neither ever comes from the URL.
  const rows = await listSites(getDb(), session.organisationId, { clientId: session.clientId });

  return (
    <>
      <PageHeader
        title="Websites"
        description="The sites we build, host and look after for you."
        category="delivery"
      />

      <DataList
        rows={rows}
        columns={COLUMNS}
        getRowKey={(row) => row.id}
        caption="Your websites"
        empty={
          <EmptyState icon={Globe}>
            No websites on your account yet. We will list yours here as soon as one is under way.
          </EmptyState>
        }
      />
    </>
  );
}
