"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
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
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          const result = await deleteDnsRecordAction({ recordId, domainId });
          if (result.status === "error") return void toast.error(result.message);
          toast.success("DNS record removed");
          router.refresh();
        });
      }}
      className="text-xs text-neutral-500 hover:text-red-600 disabled:opacity-50"
    >
      Remove
    </button>
  );
}
