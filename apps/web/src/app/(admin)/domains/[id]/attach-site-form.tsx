"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
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
  const fieldId = useId();
  const [value, setValue] = useState(siteId ?? "");
  const [isPending, startTransition] = useTransition();

  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
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
      <div className="min-w-0 space-y-1.5 sm:w-72">
        <Label htmlFor={fieldId}>Points at</Label>
        <NativeSelect
          id={fieldId}
          name="siteId"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="">Not assigned</option>
          {sites.map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <Button type="submit" variant="secondary" loading={isPending} className="max-sm:w-full">
        Save
      </Button>
    </form>
  );
}
