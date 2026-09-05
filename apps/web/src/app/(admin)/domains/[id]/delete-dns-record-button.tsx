"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { deleteDnsRecordAction } from "../actions";

/**
 * A plain button calling the server action directly rather than a
 * `<form action={deleteDnsRecordAction}>` so the ActionResult's error message
 * can be toasted instead of surfacing as an uncaught server error.
 */
export function DeleteDnsRecordButton({ recordId, domainId }: { recordId: string; domainId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      size="sm"
      // One per DNS record row.
      variant="destructive-quiet"
      loading={isPending}
      onClick={() => {
        startTransition(async () => {
          const result = await deleteDnsRecordAction({ recordId, domainId });
          if (result.status === "error") return void toast.error(result.message);
          toast.success("DNS record removed");
          router.refresh();
        });
      }}
    >
      Remove
    </Button>
  );
}
