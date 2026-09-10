"use client";

import { RefreshCw } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { showSaved } from "@/components/saved-overlay";
import { Button } from "@/components/ui/button";
import { refreshSiteScreenshotAction } from "./actions";

/**
 * Take a fresh picture of this site, now.
 *
 * The whole reason the scheduled job can be as lazy as it is: nothing needs to
 * re-photograph every site nightly on the off-chance one changed, because the
 * person who knows a site changed can say so.
 *
 * A failure is a toast carrying the provider's own reason — "403 from the
 * site", "no answer within 30000 ms" — rather than "something went wrong". The
 * previous picture is kept either way, so a failed refresh never leaves an
 * empty square where a screenshot used to be.
 */
export function RefreshScreenshotButton({ siteId, name }: { siteId: string; name: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      loading={pending}
      // The accessible name says which site, because a grid renders twenty of
      // these and "Refresh" alone identifies none of them.
      aria-label={`Take a new screenshot of ${name}`}
      onClick={() =>
        startTransition(async () => {
          const result = await refreshSiteScreenshotAction(siteId);
          if (result.status === "error") toast.error(result.message);
          else showSaved(`New screenshot of ${name}.`);
        })
      }
    >
      <RefreshCw aria-hidden />
      Refresh
    </Button>
  );
}
