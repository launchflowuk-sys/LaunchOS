import type { FunnelRow } from "@launchos/core";
import type { FunnelStep } from "@launchos/db/schema";
import { ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { addStepAction, moveStepAction, removeStepAction, saveStepAction } from "../actions";
import { optionLines } from "../schemas";

/**
 * The questions, one card each, in the order a visitor meets them.
 *
 * Plain forms rather than a drag-and-drop builder: this is edited a handful of
 * times a year, usually to change a single word, and a form that posts is a
 * form that works on Shoji's phone at eleven at night. The contact card is
 * marked out because where it sits is the whole design — the editor says so,
 * and core refuses to save an order that puts it last.
 */

const KIND_LABEL: Record<FunnelStep["kind"], string> = {
  choice: "Multiple choice",
  text: "Free text",
  contact: "Name and number",
};

export function StepEditor({ funnel }: { funnel: FunnelRow }) {
  const contactAt = funnel.steps.findIndex((step) => step.kind === "contact");

  return (
    <div className="grid gap-4">
      {funnel.steps.map((step, index) => (
        <StepCard
          key={step.key}
          funnelId={funnel.id}
          step={step}
          index={index}
          total={funnel.steps.length}
          isContact={index === contactAt}
        />
      ))}

      <div className="flex flex-wrap gap-2">
        <ActionForm action={addStepAction} success="Question added" ariaLabel="Add a multiple-choice question">
          <input type="hidden" name="funnelId" value={funnel.id} />
          <input type="hidden" name="kind" value="choice" />
          <Button type="submit" variant="secondary" size="sm">
            Add a multiple choice question
          </Button>
        </ActionForm>
        <ActionForm action={addStepAction} success="Question added" ariaLabel="Add a free-text question">
          <input type="hidden" name="funnelId" value={funnel.id} />
          <input type="hidden" name="kind" value="text" />
          <Button type="submit" variant="secondary" size="sm">
            Add a free text question
          </Button>
        </ActionForm>
      </div>
    </div>
  );
}

function StepCard({
  funnelId,
  step,
  index,
  total,
  isContact,
}: {
  funnelId: string;
  step: FunnelStep;
  index: number;
  total: number;
  isContact: boolean;
}) {
  const id = (field: string) => `step-${step.key}-${field}`;

  return (
    <section className="rounded-xl border bg-card p-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="label-caps text-muted-foreground">
            Screen {index + 1} · {KIND_LABEL[step.kind]}
          </p>
          <p className="font-mono text-meta text-muted-foreground">{step.key}</p>
          {isContact ? (
            <p className="mt-1 text-sm text-primary">
              This is the screen that makes the lead. Keep it in the middle — everything after it is a bonus.
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1.5">
          <MoveButton funnelId={funnelId} stepKey={step.key} direction="up" disabled={index === 0} />
          <MoveButton funnelId={funnelId} stepKey={step.key} direction="down" disabled={index === total - 1} />
          {isContact ? null : (
            <ActionForm action={removeStepAction} success="Question removed" ariaLabel={`Remove ${step.question}`}>
              <input type="hidden" name="funnelId" value={funnelId} />
              <input type="hidden" name="stepKey" value={step.key} />
              <Button type="submit" variant="destructive-quiet" size="icon" aria-label="Remove this question">
                <Trash2 className="size-4" strokeWidth={1.75} aria-hidden />
              </Button>
            </ActionForm>
          )}
        </div>
      </header>

      <ActionForm action={saveStepAction} success="Question saved" ariaLabel={step.question} className="grid gap-4">
        <input type="hidden" name="funnelId" value={funnelId} />
        <input type="hidden" name="stepKey" value={step.key} />

        <div className="space-y-1.5">
          <Label htmlFor={id("question")}>Question</Label>
          <Input id={id("question")} name="question" required maxLength={300} defaultValue={step.question} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id("help")}>Line underneath</Label>
          <Input id={id("help")} name="help" maxLength={300} defaultValue={step.help ?? ""} />
        </div>

        {step.kind === "choice" ? (
          <div className="space-y-1.5">
            <Label htmlFor={id("options")}>Answers</Label>
            <Textarea id={id("options")} name="options" rows={5} defaultValue={optionLines(step.options)} className="font-mono text-sm" />
            <p className="text-meta text-muted-foreground">
              One answer a line, as <span className="font-mono">Label | points</span>. Points add up to the score; a negative number is
              allowed — &quot;just looking&quot; should cost.
            </p>
          </div>
        ) : null}

        {step.kind === "text" ? (
          <div className="space-y-1.5">
            <Label htmlFor={id("placeholder")}>Grey text in the box</Label>
            <Input id={id("placeholder")} name="placeholder" maxLength={120} defaultValue={step.placeholder ?? ""} />
          </div>
        ) : null}

        {step.kind === "contact" ? (
          <fieldset className="grid gap-2.5">
            <legend className="mb-1 text-sm font-medium">What this screen asks for</legend>
            <p className="text-meta text-muted-foreground">A name and a phone number are always asked for. These are the extras.</p>
            <CheckRow id={id("askEmail")} name="askEmail" defaultChecked={step.contact?.askEmail ?? true} label="Ask for an email address" />
            <CheckRow
              id={id("emailRequired")}
              name="emailRequired"
              defaultChecked={step.contact?.emailRequired ?? false}
              label="Insist on the email address"
              hint="Off by default: a phone number on its own is still a lead, and a required field is the commonest reason a half-finished funnel produces nothing."
            />
            <CheckRow id={id("askBusiness")} name="askBusiness" defaultChecked={step.contact?.askBusiness ?? false} label="Ask for the business name" />
          </fieldset>
        ) : null}

        <CheckRow id={id("required")} name="required" defaultChecked={step.required} label="They must answer this one to move on" />

        <div>
          <Button type="submit" size="sm">
            Save this question
          </Button>
        </div>
      </ActionForm>
    </section>
  );
}

function MoveButton({
  funnelId,
  stepKey,
  direction,
  disabled,
}: {
  funnelId: string;
  stepKey: string;
  direction: "up" | "down";
  disabled: boolean;
}) {
  const Icon = direction === "up" ? ChevronUp : ChevronDown;
  return (
    <ActionForm action={moveStepAction} ariaLabel={`Move ${direction}`}>
      <input type="hidden" name="funnelId" value={funnelId} />
      <input type="hidden" name="stepKey" value={stepKey} />
      <input type="hidden" name="direction" value={direction} />
      <Button type="submit" variant="secondary" size="icon" disabled={disabled} aria-label={`Move this question ${direction}`}>
        <Icon className="size-4" strokeWidth={1.75} aria-hidden />
      </Button>
    </ActionForm>
  );
}

function CheckRow({
  id,
  name,
  label,
  hint,
  defaultChecked,
}: {
  id: string;
  name: string;
  label: string;
  hint?: string;
  defaultChecked: boolean;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox id={id} name={name} defaultChecked={defaultChecked} className="mt-0.5" />
      <div className="min-w-0">
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        {hint ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}
