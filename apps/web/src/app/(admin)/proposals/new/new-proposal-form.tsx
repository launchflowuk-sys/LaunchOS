"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { createProposalAction } from "../actions";
import { SHAPE_OPTION_HINT, SHAPE_OPTION_LABEL } from "../schemas";

export type SubjectOption = { value: string; label: string; group: "Leads" | "Clients" };

const SHAPES = ["monthly_on_delivery", "setup_plus_monthly", "one_off"] as const;

/**
 * Drafting a proposal: who it is for, what it is called, how it is paid for,
 * and how long it stands. Nothing is priced here — the lines come next, on
 * the proposal's own screen, because they are what the price is derived from
 * and they need the running totals beside them.
 *
 * The shape is asked for now rather than later because it decides which kinds
 * of line the proposal may carry: a one-off proposal can never hold a monthly
 * line, and finding that out after typing six of them is a waste of somebody's
 * afternoon.
 */
export function NewProposalForm({ subjects, defaultValidUntil }: { subjects: readonly SubjectOption[]; defaultValidUntil: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shape, setShape] = useState<(typeof SHAPES)[number]>("monthly_on_delivery");
  const [error, setError] = useState<string | null>(null);

  const leads = subjects.filter((s) => s.group === "Leads");
  const clients = subjects.filter((s) => s.group === "Clients");

  return (
    <form
      aria-label="New proposal"
      className="grid max-w-2xl gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setError(null);
        start(async () => {
          const result = await createProposalAction({
            subject: String(form.get("subject") ?? ""),
            title: String(form.get("title") ?? ""),
            shape: String(form.get("shape") ?? "") as (typeof SHAPES)[number],
            validUntil: String(form.get("validUntil") ?? ""),
            summary: String(form.get("summary") ?? ""),
          });
          if (result.status === "error") {
            setError(result.message);
            return void toast.error(result.message);
          }
          toast.success("Proposal drafted — add the priced lines next");
          router.push(`/proposals/${result.id}`);
        });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="subject">Who is it for?</Label>
        <NativeSelect id="subject" name="subject" required defaultValue="" className="h-9">
          <option value="" disabled>
            Choose a lead or a client
          </option>
          {leads.length > 0 ? (
            <optgroup label="Leads">
              {leads.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {clients.length > 0 ? (
            <optgroup label="Clients">
              {clients.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ) : null}
        </NativeSelect>
        <p className="text-meta text-muted-foreground">
          A proposal for a lead turns them into a client the moment they accept it.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" required maxLength={300} placeholder="New website and hosting for Grays CabLine" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="shape">How is it paid for?</Label>
        <NativeSelect
          id="shape"
          name="shape"
          className="h-9"
          value={shape}
          onChange={(event) => setShape(event.target.value as (typeof SHAPES)[number])}
        >
          {SHAPES.map((value) => (
            <option key={value} value={value}>
              {SHAPE_OPTION_LABEL[value]}
            </option>
          ))}
        </NativeSelect>
        <p className="text-meta text-muted-foreground">{SHAPE_OPTION_HINT[shape]}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="validUntil">Valid until</Label>
        <Input id="validUntil" name="validUntil" type="date" defaultValue={defaultValidUntil} className="w-full sm:w-56" />
        <p className="text-meta text-muted-foreground">
          The last day they can accept, read as the end of that day in the UK. A month is the usual answer.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="summary">Summary (optional)</Label>
        <Textarea id="summary" name="summary" rows={4} maxLength={4000} placeholder="A paragraph in your own words: what they asked for and what we are proposing." />
      </div>

      {error ? (
        <InlineAlert tone="danger" title="Not drafted">
          {error}
        </InlineAlert>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending} className="max-sm:w-full">
          Draft the proposal
        </Button>
      </div>
    </form>
  );
}
