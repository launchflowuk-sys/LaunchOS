import { listSites } from "@launchos/core";
import { EmptyState, PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

export default async function PortalSitesPage() {
  const session = await requireClient();
  // `listSites` filters on the organisation; `clientId` from the session is the
  // second half of the scope. Neither ever comes from the URL.
  const rows = await listSites(getDb(), session.organisationId, { clientId: session.clientId });

  return (
    <>
      <PageHeader title="Websites" description="The sites we build, host and look after for you." />

      {rows.length === 0 ? (
        <EmptyState>No websites on your account yet.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>URL</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium text-neutral-900">{row.name}</TableCell>
                  <TableCell>
                    {isSafeUrl(row.primaryUrl) ? (
                      <a
                        href={row.primaryUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-neutral-700 hover:underline"
                      >
                        {row.primaryUrl}
                      </a>
                    ) : (
                      <span className="text-neutral-700">{row.primaryUrl}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-neutral-600">{row.platform}</TableCell>
                  <TableCell>
                    <StatusBadge value={row.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
