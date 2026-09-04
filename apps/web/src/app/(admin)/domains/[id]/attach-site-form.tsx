"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { attachDomainToSiteAction } from "../actions";

type SiteOption = { id: string; name: string };

/**
 * A client component rather than a plain `<form action={attachDomainToSiteAction}>`
 * so the ActionResult's error message can be toasted instead of surfacing as an
 * uncaught server error on a bare POST.
 */
export function AttachSiteForm({
  domainId,
  siteId,
  sites,
}: {
  domainId: string;
  siteId: string | null;
  sites: SiteOption[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(siteId ?? "");
  const [isPending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await attachDomainToSiteAction({ domainId, siteId: value });
          if (result.status === "error") return void toast.error(result.message);
          toast.success("Website updated");
          router.refresh();
        });
      }}
    >
      <div className="space-y-1.5">
        <label htmlFor="siteId" className="block text-sm font-medium text-neutral-700">
          Points at
        </label>
        <select
          id="siteId"
          name="siteId"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="h-9 w-64 rounded-md border border-neutral-300 px-3 text-sm focus:border-neutral-400 focus:outline-none"
        >
          <option value="">Not assigned</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="outline" disabled={isPending}>
        Save
      </Button>
    </form>
  );
}
