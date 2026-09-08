import type { SiteThumbnail } from "@launchos/core";
import Link from "next/link";
import { DetailDrawer } from "@/components/detail-drawer";
import { KeyValue } from "@/components/key-value";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { RefreshScreenshotButton } from "./refresh-screenshot-button";
import { SiteThumb } from "./site-thumb";

type SiteRow = {
  id: string;
  name: string;
  primaryUrl: string;
  clientId: string;
  clientName: string;
  status: string;
  platform: string;
  domainCount: number;
  openIncidentCount: number;
};

/**
 * The websites as pictures.
 *
 * This is the view the thumbnails are for. A table of site names tells you
 * what we host; a wall of screenshots tells you what our work looks like,
 * which is the question asked when a client's homepage has quietly broken, a
 * redesign has gone live, or somebody wants a case study.
 *
 * Each card carries a drawer rather than only a link: the point of scanning
 * twenty sites is to check three of them, and three navigations plus three
 * back buttons is what makes people stop scanning.
 */
export function SiteGrid({
  sites,
  thumbnails,
}: {
  sites: readonly SiteRow[];
  thumbnails: Map<string, SiteThumbnail>;
}) {
  return (
    <ul className="grid min-w-0 gap-5 sm:grid-cols-2 xl:grid-cols-3">
      {sites.map((site) => {
        const thumbnail = thumbnails.get(site.id);
        return (
          <li key={site.id} className="min-w-0 rounded-[20px] border bg-card p-4">
            <SiteThumb siteId={site.id} name={site.name} thumbnail={thumbnail} />

            <div className="mt-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link href={`/websites/${site.id}`} className="block truncate font-semibold hover:underline">
                  {site.name}
                </Link>
                <p className="mt-0.5 truncate text-meta text-muted-foreground">{site.primaryUrl}</p>
              </div>
              <StatusBadge value={site.status} className="shrink-0" />
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="min-w-0 truncate text-meta text-muted-foreground">{site.clientName}</p>
              <DetailDrawer
                title={site.name}
                description={site.primaryUrl}
                href={`/websites/${site.id}`}
                trigger={
                  <Button variant="secondary" size="sm" className="shrink-0">
                    Preview
                  </Button>
                }
              >
                <SiteThumb siteId={site.id} name={site.name} thumbnail={thumbnail} className="mb-5" />
                <KeyValue
                  items={[
                    { label: "Status", value: <StatusBadge value={site.status} /> },
                    { label: "Client", value: site.clientName },
                    { label: "Platform", value: site.platform },
                    { label: "Domains", value: site.domainCount },
                    {
                      label: "Open incidents",
                      value:
                        site.openIncidentCount > 0 ? (
                          <span className="font-semibold text-danger-fg">{site.openIncidentCount}</span>
                        ) : (
                          "None"
                        ),
                    },
                    {
                      label: "Picture taken",
                      value: thumbnail?.capturedAt ? formatDateTime(thumbnail.capturedAt) : "Never",
                      // The reason belongs next to the date, because a stale
                      // date without one reads as neglect rather than a fault.
                      ...(thumbnail?.failureReason ? { hint: `Last attempt failed: ${thumbnail.failureReason}` } : {}),
                    },
                  ]}
                />
                <div className="mt-5">
                  <RefreshScreenshotButton siteId={site.id} name={site.name} />
                </div>
              </DetailDrawer>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
