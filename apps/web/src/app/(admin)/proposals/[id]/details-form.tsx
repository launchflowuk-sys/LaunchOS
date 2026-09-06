import type { ProposalRow } from "@launchos/core";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { updateProposalAction } from "../actions";
import { SHAPE_OPTION_HINT, SHAPE_OPTION_LABEL } from "../schemas";

const SHAPES = ["monthly_on_delivery", "setup_plus_monthly", "one_off"] as const;

/**
 * The words on the document: what it is called, what we are doing, what we
 * are not, roughly when, and on what terms.
 *
 * Deliverables and out-of-scope are textareas of one item per line rather
 * than a repeating field editor, because that is how somebody writes a list
 * when they are thinking about the work instead of about the form.
 *
 * A server component around `ActionForm`, so there is no client component for
 * a form that is nothing but fields and a Save.
 */
export function DetailsForm({ proposal }: { proposal: ProposalRow }) {
  const scope = proposal.scope;

  return (
    <ActionForm action={updateProposalAction} ariaLabel="Proposal details" success="Proposal saved" className="grid gap-5">
      <input type="hidden" name="proposalId" value={proposal.id} />

      <div className="space-y-1.5">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" defaultValue={proposal.title} maxLength={300} required />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="summary">Summary</Label>
        <Textarea id="summary" name="summary" rows={4} maxLength={4000} defaultValue={proposal.summary ?? ""} placeholder="What they asked for, and what we are proposing, in your own words." />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="deliverables">What we will do</Label>
          <Textarea id="deliverables" name="deliverables" rows={6} defaultValue={scope.deliverables.join("\n")} placeholder={"One per line:\nFive-page website\nHosting and backups\nGoogle Business profile"} />
          <p className="text-meta text-muted-foreground">One deliverable per line.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="outOfScope">What is not included</Label>
          <Textarea id="outOfScope" name="outOfScope" rows={6} defaultValue={scope.outOfScope.join("\n")} placeholder={"One per line:\nPhotography\nPaid advertising budget"} />
          <p className="text-meta text-muted-foreground">Saying it here is cheaper than saying it later.</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="timeline">Timing</Label>
        <Textarea id="timeline" name="timeline" rows={2} maxLength={1000} defaultValue={scope.timeline} placeholder="About three weeks from the go-ahead, once we have your content." />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="shape">How it is paid for</Label>
          <NativeSelect id="shape" name="shape" defaultValue={proposal.pricing.shape} className="h-9">
            {SHAPES.map((value) => (
              <option key={value} value={value}>
                {SHAPE_OPTION_LABEL[value]}
              </option>
            ))}
          </NativeSelect>
          <p className="text-meta text-muted-foreground">{SHAPE_OPTION_HINT[proposal.pricing.shape]}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="validUntil">Valid until</Label>
          <Input id="validUntil" name="validUntil" type="date" defaultValue={proposal.validUntil ?? ""} />
          <p className="text-meta text-muted-foreground">The end of that day, UK time.</p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vatNote">Note under the figures</Label>
        <Input id="vatNote" name="vatNote" maxLength={300} defaultValue={proposal.pricing.vatNote} placeholder="All prices are in pounds sterling." />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="terms">Terms</Label>
        <Textarea id="terms" name="terms" rows={6} maxLength={20_000} defaultValue={proposal.terms ?? ""} placeholder="Payment terms, what happens if the work changes, how either side ends it." />
      </div>

      <div>
        <Button type="submit" className="max-sm:w-full">
          Save the proposal
        </Button>
      </div>
    </ActionForm>
  );
}
