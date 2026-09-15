import { siteDeletionReport } from "@launchos/core";
import { ActionForm } from "@/components/action-form";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { deleteSiteAction } from "./actions";

/**
 * Deleting a website record, with what stands in the way shown before
 * anything is typed.
 *
 * The confirmation is the **address**, not the name, and that is the whole
 * point: the case this exists for is two rows called "Gateway Taxis", where
 * typing the name would confirm nothing about which one is going.
 */
export async function DeleteSiteSection({ siteId }: { siteId: string }) {
  const session = await requireAdmin();
  const report = await siteDeletionReport(getDb(), session.organisationId, siteId);

  return (
    <div className="rounded-[20px] border bg-card p-5">
      {report.blockers.length > 0 ? (
        <InlineAlert tone="danger" title="This website cannot be deleted">
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {report.blockers.map((blocker) => (
              <li key={blocker.kind}>{blocker.detail}</li>
            ))}
          </ul>
          <p className="mt-3">
            Clear whatever depends on it and this button will work. Nothing is deleted quietly on your behalf.
          </p>
        </InlineAlert>
      ) : (
        <>
          {report.cascades.length > 0 ? (
            <InlineAlert tone="warning" title="This will also delete">
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {report.cascades.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </InlineAlert>
          ) : (
            <p className="text-row text-muted-foreground">
              Nothing depends on this website. Deleting removes the record itself.
            </p>
          )}

          <ActionForm
            action={deleteSiteAction}
            ariaLabel={`Delete ${report.primaryUrl}`}
            success="Website deleted"
            className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end"
          >
            <input type="hidden" name="siteId" value={siteId} />
            <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-md">
              <Label htmlFor={`delete-site-${siteId}`}>Type the address to confirm</Label>
              <Input
                id={`delete-site-${siteId}`}
                name="confirmUrl"
                placeholder={report.primaryUrl}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Button type="submit" variant="destructive" className="max-sm:w-full">
              Delete website
            </Button>
          </ActionForm>
        </>
      )}
    </div>
  );
}
