"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { recordManualPayment } from "./actions";

type Option = { value: string; label: string };
type InvoiceOption = Option & { clientId: string };

const FIELD = "h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900";

/**
 * The options arrive as props rather than being queried here: `@launchos/db`
 * pulls in the postgres driver, which cannot be bundled for the browser, and
 * this is a client component.
 */
export function RecordPaymentDialog({
  clients,
  invoices,
  providers,
}: {
  clients: Option[];
  invoices: InvoiceOption[];
  providers: readonly string[];
}) {
  const [open, setOpen] = useState(false);
  // The invoice list is narrowed to the chosen client. Two clients can hold
  // open invoices for the identical amount, and picking the adjacent row would
  // otherwise settle the wrong client's invoice with money that never arrived
  // from them — core refuses the mismatch, but the field should not offer it.
  const [clientId, setClientId] = useState("");
  const clientInvoices = invoices.filter((i) => i.clientId === clientId);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>Record payment</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record a payment</DialogTitle>
        </DialogHeader>
        <form
          action={async (formData) => {
            const result = await recordManualPayment(formData);
            if (result.status === "error") return void toast.error(result.message);
            toast.success("Payment recorded");
            setClientId("");
            setOpen(false);
          }}
          className="space-y-3"
        >
          <label className="block text-xs text-neutral-500">
            Client
            <select
              name="clientId"
              required
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
              className={FIELD}
            >
              <option value="" disabled>
                Choose a client
              </option>
              {clients.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-neutral-500">
            Invoice
            {/* Remounted per client so a selection made for the previous one
                cannot survive into the new list. */}
            <select key={clientId} name="invoiceId" defaultValue="" disabled={clientId === ""} className={FIELD}>
              <option value="">
                {clientId === ""
                  ? "Choose a client first"
                  : clientInvoices.length === 0
                    ? "No open invoices — on account"
                    : "No invoice — on account"}
              </option>
              {clientInvoices.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs text-neutral-500">
              Amount (£)
              <input
                name="amountPounds"
                type="number"
                step="0.01"
                min="0.01"
                required
                className={FIELD}
                placeholder="118.80"
              />
            </label>
            <label className="block text-xs text-neutral-500">
              Provider
              <select name="provider" defaultValue="bank" className={FIELD}>
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-xs text-neutral-500">
            Reference
            <input name="providerRef" maxLength={200} className={FIELD} placeholder="Bank statement reference" />
          </label>
          <DialogFooter>
            <Button type="submit">Record payment</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
