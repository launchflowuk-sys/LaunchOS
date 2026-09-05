"use client";

import { useState } from "react";
import { toast } from "sonner";
import { NativeSelect } from "@/components/ui/native-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { recordManualPayment } from "./actions";

type Option = { value: string; label: string };
type InvoiceOption = Option & { clientId: string };

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
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="payment-client">Client</Label>
            <NativeSelect
              id="payment-client"
              name="clientId"
              required
              value={clientId}
              onChange={(event) => setClientId(event.target.value)}
            >
              <option value="" disabled>
                Choose a client
              </option>
              {clients.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payment-invoice">Invoice</Label>
            {/* Remounted per client so a selection made for the previous one
                cannot survive into the new list. */}
            <NativeSelect
              key={clientId}
              id="payment-invoice"
              name="invoiceId"
              defaultValue=""
              disabled={clientId === ""}
            >
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
            </NativeSelect>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="payment-amount">Amount (£)</Label>
              <Input
                id="payment-amount"
                name="amountPounds"
                type="number"
                step="0.01"
                min="0.01"
                required
                placeholder="118.80"
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payment-provider">Provider</Label>
              <NativeSelect id="payment-provider" name="provider" defaultValue="bank">
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="payment-reference">Reference</Label>
            <Input id="payment-reference" name="providerRef" maxLength={200} placeholder="Bank statement reference" />
          </div>

          <DialogFooter>
            <Button type="submit">Record payment</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
