"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createInvoiceForClient } from "@/app/(admin)/invoices/actions";

/**
 * Raises an invoice from the client's active subscription and opens it.
 *
 * The navigation happens here rather than with `redirect()` in the action: the
 * action reports failure as an `ActionResult`, and `redirect` signals itself by
 * throwing, which its own try/catch would swallow.
 */
export function RaiseInvoiceButton({ clientId }: { clientId: string }) {
  const router = useRouter();

  return (
    <form
      action={async (formData) => {
        const result = await createInvoiceForClient(formData);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Invoice raised");
        if (result.id) router.push(`/invoices/${result.id}`);
      }}
    >
      <input type="hidden" name="clientId" value={clientId} />
      <Button type="submit">Raise invoice</Button>
    </form>
  );
}
