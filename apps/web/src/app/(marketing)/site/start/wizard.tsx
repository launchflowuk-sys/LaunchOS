"use client";

import { ArrowLeft, ArrowRight, CircleCheck, Loader2 } from "lucide-react";
import { useActionState, useState } from "react";
import type { TradingStructure, TriageAnswer } from "@launchos/core";
import { BrandMark } from "@/components/brand-mark";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REPLY_PROMISE } from "@/lib/marketing/site";
import { cn } from "@/lib/utils";
import { startAction } from "./actions";
import { HONEYPOT_FIELD } from "./schema";

/**
 * The options, restated here rather than imported.
 *
 * `@launchos/core` is a *value* import away from the database driver, and a
 * "use client" module that reaches for one fails at runtime with
 * `Can't resolve 'net'` while typechecking perfectly — the boundary is not
 * visible to `tsc`. Only the types cross, and types are erased at build.
 *
 * `satisfies` is what stops these drifting: add a structure in core and this
 * file stops compiling until it is listed here too.
 */
const TRADING_STRUCTURES = ["sole_trader", "limited_company", "partnership", "not_sure"] as const;
const TRADING_STRUCTURE_LABEL = {
  sole_trader: "Sole trader",
  limited_company: "Limited company",
  partnership: "Partnership",
  not_sure: "Not sure yet",
} satisfies Record<TradingStructure, string>;

const TRIAGE_ANSWERS = ["yes", "no", "unsure"] as const;
const TRIAGE_LABEL = {
  yes: "Yes",
  no: "No",
  unsure: "Not sure",
} satisfies Record<TriageAnswer, string>;


/**
 * The enquiry, asked properly.
 *
 * `/contact` collects a name, an email and a sentence — which means the first
 * real work on every job is a phone call to find out what the business actually
 * does, and nothing can start until Shoji makes it. This asks those questions
 * up front so the Brief Writer, the content plan and the site build begin with
 * material instead of a name.
 *
 * Contact details are on step one, deliberately. Asked last it reads better and
 * more people who reach the end will finish — but most people who abandon a
 * form abandon it in the middle, and asking last means every one of them leaves
 * nothing at all. Answered first, somebody who quits on step three is still a
 * lead with an industry attached.
 *
 * One `<form>` wraps every step and the fields simply hide, so nothing is held
 * in state that a browser autofill or a back button could disagree with, and
 * the whole thing posts once.
 */

const STEPS = [
  { key: "you", title: "Who we're speaking to", blurb: "So we can get back to you." },
  { key: "business", title: "Your business", blurb: "What you are and what you're called." },
  { key: "presence", title: "Where you are now", blurb: "What already exists, so nothing gets rebuilt for no reason." },
  { key: "services", title: "What you do", blurb: "In your own words — this is what the site has to say." },
  { key: "goals", title: "What you want", blurb: "The point of the whole thing." },
  { key: "review", title: "Check it over", blurb: "Change anything before it comes to us." },
] as const;

type Values = Record<string, string>;

const FIELD_LABELS: Record<string, string> = {
  name: "Your name",
  email: "Email",
  phone: "Phone",
  business: "Business name",
  industry: "Industry",
  tradingStructure: "Structure",
  websiteUrl: "Current website",
  hasGoogleListing: "Google Business listing",
  hasFacebookPage: "Facebook page",
  serviceArea: "Areas covered",
  services: "Services",
  goals: "Goals",
  timeline: "Timeline",
  budget: "Budget",
};

const REVIEW_ORDER = Object.keys(FIELD_LABELS);

function prettyValue(field: string, value: string): string {
  if (field === "tradingStructure") return TRADING_STRUCTURE_LABEL[value as keyof typeof TRADING_STRUCTURE_LABEL] ?? value;
  if (field === "hasGoogleListing" || field === "hasFacebookPage") {
    return TRIAGE_LABEL[value as keyof typeof TRIAGE_LABEL] ?? value;
  }
  return value;
}

function Field({
  name, label, hint, type = "text", required, values, onChange, placeholder,
}: {
  name: string;
  label: string;
  hint?: string;
  type?: string;
  required?: boolean;
  values: Values;
  onChange: (name: string, value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>
        {label}
        {required ? null : <span className="ml-2 text-meta font-normal text-muted-foreground">Optional</span>}
      </Label>
      {/* 16px at 44px tall, as on /sign-in: filled in on a phone by a stranger,
          and 16px is what stops iOS zooming the page on focus. */}
      <Input
        id={name}
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        value={values[name] ?? ""}
        onChange={(event) => onChange(name, event.target.value)}
        className="h-11 text-base"
      />
      {hint ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function AreaField({
  name, label, hint, values, onChange, placeholder,
}: { name: string; label: string; hint?: string; values: Values; onChange: (n: string, v: string) => void; placeholder?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>
        {label}
        <span className="ml-2 text-meta font-normal text-muted-foreground">Optional</span>
      </Label>
      <Textarea
        id={name}
        name={name}
        rows={4}
        placeholder={placeholder}
        value={values[name] ?? ""}
        onChange={(event) => onChange(name, event.target.value)}
        className="text-base"
      />
      {hint ? <p className="text-meta text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Radio buttons drawn as cards. Bigger targets on a phone than a native radio. */
function ChoiceField({
  name, label, options, values, onChange,
}: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  values: Values;
  onChange: (n: string, v: string) => void;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {label}
        <span className="ml-2 text-meta font-normal text-muted-foreground">Optional</span>
      </legend>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const active = values[name] === option.value;
          return (
            <label
              key={option.value}
              className={cn(
                "cursor-pointer rounded-full border px-4 py-2 text-sm transition-colors",
                active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted",
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={active}
                onChange={() => onChange(name, option.value)}
                className="sr-only"
              />
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function StartWizard({ page }: { page: string }) {
  const [state, formAction, pending] = useActionState(startAction, null);
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<Values>({});

  const set = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));

  if (state?.status === "ok") {
    return (
      <div role="status" className="rounded-2xl border border-success-border bg-success-bg p-8 text-success-fg">
        <div className="flex items-start gap-3">
          <CircleCheck aria-hidden className="mt-0.5 size-6 shrink-0" />
          <div className="min-w-0">
            <p className="text-xl font-semibold">Thanks — that's everything we need to start.</p>
            <p className="mt-2 text-sm">{REPLY_PROMISE}</p>
            <div className="mt-5 space-y-2 text-sm">
              <p className="font-semibold">What happens next</p>
              <ol className="list-decimal space-y-1 pl-5">
                <li>We read what you sent and look at anything you already have online.</li>
                <li>You get a written brief back — what we would build and what it would cost.</li>
                <li>If it looks right, we start. Nothing is charged before you have agreed it.</li>
              </ol>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const current = STEPS[step]!;
  const isReview = current.key === "review";
  // Step one is the only one that can hold you up, and only when it is empty.
  const canAdvance = step > 0 || (Boolean(values.name?.trim()) && Boolean(values.email?.trim()));

  return (
    <form
      action={formAction}
      aria-label="Start a project"
      className="mx-auto w-full max-w-2xl rounded-[24px] border bg-card p-6 shadow-xl sm:p-10"
    >
      <input type="hidden" name="page" value={page} />
      {/* Invisible to a person, out of the tab order, irresistible to a script. */}
      <input
        type="text"
        name={HONEYPOT_FIELD}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden
        className="sr-only"
        value={values[HONEYPOT_FIELD] ?? ""}
        onChange={(event) => set(HONEYPOT_FIELD, event.target.value)}
      />

      <div className="mb-8 flex items-center justify-between gap-4">
        <BrandMark />
        <p className="text-meta text-muted-foreground">
          Step {step + 1} of {STEPS.length}
        </p>
      </div>

      {/* A bar rather than dots: six dots read as decoration, a bar reads as
          progress and tells somebody on step four that they are nearly done. */}
      <div className="mb-8 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all duration-300"
          style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
        />
      </div>

      <div className="mb-7">
        <h2 className="text-2xl font-semibold tracking-tight text-balance">{current.title}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">{current.blurb}</p>
      </div>

      {state?.status === "error" ? (
        <InlineAlert tone="danger" className="mb-6">
          {state.message}
        </InlineAlert>
      ) : null}

      {/* Every step stays mounted and hides. Unmounting would drop what a
          browser autofilled and lose an answer on the way back. */}
      <div className="space-y-6">
        <div hidden={current.key !== "you"} className="space-y-6">
          <Field name="name" label="Your name" required values={values} onChange={set} placeholder="Sam Taylor" />
          <Field name="email" label="Email" type="email" required values={values} onChange={set} placeholder="sam@business.co.uk" />
          <Field name="phone" label="Phone" type="tel" values={values} onChange={set} placeholder="07700 900123" />
        </div>

        <div hidden={current.key !== "business"} className="space-y-6">
          <Field name="business" label="Business name" values={values} onChange={set} placeholder="Taylor Plumbing" />
          <Field
            name="industry"
            label="Industry"
            hint="A trade, a sector, whatever you would say at a party."
            values={values}
            onChange={set}
            placeholder="Plumbing and heating"
          />
          <ChoiceField
            name="tradingStructure"
            label="How you trade"
            options={TRADING_STRUCTURES.map((value) => ({ value, label: TRADING_STRUCTURE_LABEL[value] }))}
            values={values}
            onChange={set}
          />
          <Field
            name="websiteUrl"
            label="Current website"
            hint="If you have one. We will look at it before we say anything about it."
            values={values}
            onChange={set}
            placeholder="taylorplumbing.co.uk"
          />
        </div>

        <div hidden={current.key !== "presence"} className="space-y-6">
          <ChoiceField
            name="hasGoogleListing"
            label="Do you have a Google Business listing?"
            options={TRIAGE_ANSWERS.map((value) => ({ value, label: TRIAGE_LABEL[value] }))}
            values={values}
            onChange={set}
          />
          <ChoiceField
            name="hasFacebookPage"
            label="Do you have a Facebook page?"
            options={TRIAGE_ANSWERS.map((value) => ({ value, label: TRIAGE_LABEL[value] }))}
            values={values}
            onChange={set}
          />
          <Field
            name="serviceArea"
            label="Areas you cover"
            hint="A town, a radius, or nationwide."
            values={values}
            onChange={set}
            placeholder="Grays and across Thurrock"
          />
        </div>

        <div hidden={current.key !== "services"} className="space-y-6">
          <AreaField
            name="services"
            label="What you sell"
            hint="One per line is fine. This is what the site ends up saying you do."
            values={values}
            onChange={set}
            placeholder={"Boiler servicing\nBathroom installation\nEmergency callouts"}
          />
        </div>

        <div hidden={current.key !== "goals"} className="space-y-6">
          <AreaField
            name="goals"
            label="What you want out of it"
            hint="More calls, better clients, looking the part — whatever it actually is."
            values={values}
            onChange={set}
            placeholder="More enquiries from people searching for an emergency plumber."
          />
          <Field name="timeline" label="When you need it" values={values} onChange={set} placeholder="Before the summer" />
          <Field name="budget" label="Rough budget" hint="A range is fine. It saves us both a conversation." values={values} onChange={set} />
        </div>

        {isReview ? (
          <div className="space-y-4">
            <dl className="divide-y rounded-2xl border">
              {REVIEW_ORDER.filter((field) => (values[field] ?? "").trim().length > 0).map((field) => (
                <div key={field} className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-3">
                  <dt className="w-40 shrink-0 text-meta text-muted-foreground">{FIELD_LABELS[field]}</dt>
                  <dd className="min-w-0 flex-1 text-sm break-words whitespace-pre-line">
                    {prettyValue(field, values[field]!)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-meta text-muted-foreground">
              Anything blank is fine — we will ask if we need it.
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-9 flex items-center justify-between gap-3 border-t pt-6">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setStep((n) => Math.max(0, n - 1))}
          disabled={step === 0 || pending}
          className={cn(step === 0 && "invisible")}
        >
          <ArrowLeft className="size-4" /> Back
        </Button>

        {isReview ? (
          <Button type="submit" size="lg" disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {pending ? "Sending" : "Send it over"}
          </Button>
        ) : (
          <Button
            type="button"
            size="lg"
            onClick={() => setStep((n) => Math.min(STEPS.length - 1, n + 1))}
            disabled={!canAdvance || pending}
          >
            Next <ArrowRight className="size-4" />
          </Button>
        )}
      </div>
    </form>
  );
}
