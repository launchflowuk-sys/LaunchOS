"use client";

import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { saveSubscriptionLinesAction } from "./actions";

type Line = { description: string; quantity: number; unitPounds: string };

const METHODS = [
  { value: "stripe", label: "Stripe — collects itself" },
  { value: "bank_transfer", label: "Bank transfer — we invoice, they pay" },
  { value: "standing_order", label: "Standing order — arrives on its own" },
  { value: "direct_debit", label: "Direct debit" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Something else" },
];

/**
 * What the monthly charge is made of, and how it arrives.
 *
 * The total is not typed. It is the sum of the lines, shown live as they are
 * edited, because a figure somebody can set independently of the lines is one
 * that disagrees with them by the end of the quarter — and then the invoice
 * and the screen say different things about the same client.
 *
 * Amounts are entered in pounds because that is what people say out loud.
 * They become pence once, on the server.
 */
export function BillingLinesForm({
  subscriptionId,
  clientId,
  currency,
  initialLines,
  collectionMethod,
  billingNotes,
}: {
  subscriptionId: string;
  clientId: string;
  currency: string;
  initialLines: readonly { description: string; quantity: number; unitAmountPence: number }[];
  collectionMethod: string;
  billingNotes: string | null;
}) {
  const [lines, setLines] = useState<Line[]>(() =>
    initialLines.length > 0
      ? initialLines.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        unitPounds: (line.unitAmountPence / 100).toFixed(2),
      }))
      : [{ description: "", quantity: 1, unitPounds: "" }],
  );

  const total = lines.reduce((sum, line) => sum + (Number(line.unitPounds) || 0) * (line.quantity || 1), 0);
  const symbol = currency === "GBP" ? "£" : currency === "USD" ? "$" : "";

  const update = (index: number, patch: Partial<Line>) =>
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  return (
    <ActionForm
      action={saveSubscriptionLinesAction}
      success="Billing saved"
      ariaLabel="What this client is charged"
      className="space-y-4"
    >
      <input type="hidden" name="subscriptionId" value={subscriptionId} />
      <input type="hidden" name="clientId" value={clientId} />

      <div className="space-y-2">
        {lines.map((line, index) => (
          <div key={index} className="flex min-w-0 flex-wrap items-end gap-2">
            <div className="min-w-44 flex-1 space-y-1.5">
              {index === 0 ? <Label htmlFor={`desc-${index}`}>What they are charged for</Label> : null}
              <Input
                id={`desc-${index}`}
                name="description"
                value={line.description}
                placeholder="Website care — theirsite.co.uk"
                onChange={(event) => update(index, { description: event.target.value })}
              />
            </div>
            <div className="w-20 space-y-1.5">
              {index === 0 ? <Label htmlFor={`qty-${index}`}>Qty</Label> : null}
              <Input
                id={`qty-${index}`}
                name="quantity"
                type="number"
                min={1}
                value={line.quantity}
                className="tabular-nums"
                onChange={(event) => update(index, { quantity: Number(event.target.value) || 1 })}
              />
            </div>
            <div className="w-32 space-y-1.5">
              {index === 0 ? <Label htmlFor={`amt-${index}`}>Each ({symbol || currency})</Label> : null}
              <Input
                id={`amt-${index}`}
                name="unitPounds"
                type="number"
                step="0.01"
                min={0}
                value={line.unitPounds}
                placeholder="45.00"
                className="tabular-nums"
                onChange={(event) => update(index, { unitPounds: event.target.value })}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove line ${index + 1}`}
              className="mb-0.5"
              onClick={() => setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))}
            >
              <Trash2 aria-hidden strokeWidth={1.9} className="size-4" />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => setLines((prev) => [...prev, { description: "", quantity: 1, unitPounds: "" }])}
        >
          <Plus aria-hidden strokeWidth={2} className="size-4" />
          Add a line
        </Button>
        {/* Live, so the arithmetic is visible before saving rather than after. */}
        <p className="text-row">
          <span className="text-muted-foreground">Total a month</span>{" "}
          <span className="text-figure font-bold tabular-nums">{symbol}{total.toFixed(2)}</span>
        </p>
      </div>

      <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="collectionMethod">How they pay</Label>
          <NativeSelect id="collectionMethod" name="collectionMethod" defaultValue={collectionMethod}>
            {METHODS.map((method) => (
              <option key={method.value} value={method.value}>{method.label}</option>
            ))}
          </NativeSelect>
          <p className="text-meta text-muted-foreground">
            Anything but Stripe means an invoice to raise and a payment to record each month.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="billingNotes">Notes on the arrangement</Label>
          <Input
            id="billingNotes"
            name="billingNotes"
            defaultValue={billingNotes ?? ""}
            maxLength={2000}
            placeholder="One lump sum on the 1st, reference AMO"
          />
        </div>
      </div>

      <div className="flex justify-end">
        <Button type="submit" variant="secondary">Save billing</Button>
      </div>
    </ActionForm>
  );
}
