"use client";

import type { FunnelStep, FunnelSuccess } from "@launchos/db/schema";
import { ArrowLeft, Check } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { answerAction, completeAction } from "./actions";
import type { FunnelActionResult } from "./schemas";

/**
 * One question a screen, thumb first.
 *
 * These land from a paid advert, on a phone, and every second of hesitation is
 * money. So a choice is a row of big buttons that advances the moment it is
 * tapped — the save goes off behind the visitor rather than in front of them —
 * and only the contact step waits, because that is the one where a bad email
 * address needs saying so.
 *
 * The saves are chained rather than fired in parallel: the first answer is what
 * mints the session token, and two answers racing it would start two walks.
 * `queue` is that chain; `token` is filled by whichever save returns first and
 * is read by every one after.
 */
export function FunnelRunner({
  slug,
  steps,
  success,
}: {
  slug: string;
  steps: readonly FunnelStep[];
  success: FunnelSuccess;
}) {
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, startWaiting] = useTransition();
  const token = useRef<string | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const step = steps[index];
  const last = index === steps.length - 1;

  /** Puts a save on the chain so the token from the first answer is known by the second. */
  function enqueue(values: Omit<Parameters<typeof answerAction>[0], "slug" | "token">): Promise<FunnelActionResult> {
    const run = queue.current.then(async () => {
      const result = await answerAction({ slug, ...(token.current ? { token: token.current } : {}), ...values });
      if (result.status === "ok") token.current = result.token;
      return result;
    });
    // The chain must survive a failed link, or every later answer is dropped too.
    queue.current = run.catch(() => undefined);
    return run;
  }

  /** A tap that does not need to be waited on: save behind them, move on now. */
  function advance(values: Parameters<typeof enqueue>[0]): void {
    setError(null);
    void enqueue(values).then((result) => {
      if (result.status === "error") setError(result.message);
    });
    if (!last) setIndex((current) => current + 1);
    else void finish();
  }

  /** A tap that must be waited on: the contact step, and the last screen. */
  function submit(values: Parameters<typeof enqueue>[0]): void {
    setError(null);
    startWaiting(async () => {
      const result = await enqueue(values);
      if (result.status === "error") {
        setError(result.message);
        return;
      }
      if (!last) setIndex((current) => current + 1);
      else await finish();
    });
  }

  async function finish(): Promise<void> {
    // Everything queued has to land before the walk is stamped complete.
    await queue.current;
    if (token.current) await completeAction({ slug, token: token.current });
    setDone(true);
  }

  if (done) return <SuccessScreen success={success} />;
  if (!step) return null;

  return (
    <div className="mx-auto w-full max-w-lg">
      <Progress index={index} total={steps.length} />

      <div className="mt-6 rounded-xl border bg-card p-5 sm:p-6">
        <h2 className="text-lg font-semibold tracking-tight sm:text-xl">{step.question}</h2>
        {step.help ? <p className="mt-2 text-sm text-muted-foreground">{step.help}</p> : null}

        <div className="mt-5">
          {step.kind === "choice" ? (
            <ChoiceStep step={step} onPick={(choice) => advance({ stepKey: step.key, choice })} />
          ) : null}
          {step.kind === "text" ? (
            <TextStep key={step.key} step={step} busy={waiting} onNext={(text) => submit({ stepKey: step.key, text })} />
          ) : null}
          {step.kind === "contact" ? (
            <ContactStep key={step.key} step={step} busy={waiting} onNext={(contact) => submit({ stepKey: step.key, contact })} />
          ) : null}
        </div>

        {error ? (
          <p role="alert" className="mt-4 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger-fg">
            {error}
          </p>
        ) : null}
      </div>

      {index > 0 ? (
        <button
          type="button"
          onClick={() => {
            setError(null);
            setIndex((current) => Math.max(0, current - 1));
          }}
          className="mt-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" strokeWidth={1.75} aria-hidden />
          Back
        </button>
      ) : null}
    </div>
  );
}

function Progress({ index, total }: { index: number; total: number }) {
  const percent = Math.round(((index + 1) / total) * 100);
  return (
    <div>
      <p className="label-caps text-muted-foreground">
        Question {index + 1} of {total}
      </p>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function ChoiceStep({ step, onPick }: { step: FunnelStep; onPick: (value: string) => void }) {
  return (
    <ul className="grid gap-2.5">
      {(step.options ?? []).map((option) => (
        <li key={option.value}>
          <button
            type="button"
            onClick={() => onPick(option.value)}
            className="flex min-h-14 w-full items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3 text-left text-base font-medium transition-colors hover:border-primary hover:bg-primary-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {option.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function TextStep({ step, busy, onNext }: { step: FunnelStep; busy: boolean; onNext: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onNext(text);
      }}
      className="grid gap-4"
    >
      <Textarea
        name={step.key}
        rows={4}
        placeholder={step.placeholder ?? ""}
        value={text}
        onChange={(event) => setText(event.target.value)}
        aria-label={step.question}
      />
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Continue
      </Button>
      {!step.required ? (
        <button type="button" onClick={() => onNext("")} className="text-sm text-muted-foreground transition-colors hover:text-foreground">
          Skip this one
        </button>
      ) : null}
    </form>
  );
}

function ContactStep({
  step,
  busy,
  onNext,
}: {
  step: FunnelStep;
  busy: boolean;
  onNext: (contact: { name: string; phone: string; email?: string; business?: string }) => void;
}) {
  const [values, setValues] = useState({ name: "", phone: "", email: "", business: "" });
  const set = (field: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [field]: event.target.value }));

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onNext({
          name: values.name,
          phone: values.phone,
          ...(values.email.trim() ? { email: values.email.trim() } : {}),
          ...(values.business.trim() ? { business: values.business.trim() } : {}),
        });
      }}
      className="grid gap-4"
    >
      <div className="grid gap-1.5">
        <Label htmlFor="funnel-name">Your name</Label>
        <Input id="funnel-name" name="name" autoComplete="name" required value={values.name} onChange={set("name")} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="funnel-phone">Phone number</Label>
        <Input id="funnel-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" required value={values.phone} onChange={set("phone")} />
      </div>
      {step.contact?.askEmail ? (
        <div className="grid gap-1.5">
          <Label htmlFor="funnel-email">Email {step.contact.emailRequired ? "" : <span className="text-muted-foreground">(optional)</span>}</Label>
          <Input
            id="funnel-email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required={step.contact.emailRequired}
            value={values.email}
            onChange={set("email")}
          />
        </div>
      ) : null}
      {step.contact?.askBusiness ? (
        <div className="grid gap-1.5">
          <Label htmlFor="funnel-business">
            Business name <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Input id="funnel-business" name="business" autoComplete="organization" value={values.business} onChange={set("business")} />
        </div>
      ) : null}
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Continue
      </Button>
      <p className="text-center text-meta text-muted-foreground">We never pass your details on. One call, no hard sell.</p>
    </form>
  );
}

function SuccessScreen({ success }: { success: FunnelSuccess }) {
  return (
    <div className="mx-auto w-full max-w-lg rounded-xl border bg-card p-6 text-center sm:p-8">
      <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-success-bg text-success-fg">
        <Check className="size-5" strokeWidth={1.75} aria-hidden />
      </span>
      <h2 className="mt-4 text-xl font-semibold tracking-tight">{success.headline}</h2>
      {success.body ? <p className="mt-2 text-sm text-muted-foreground">{success.body}</p> : null}
      {success.ctaLabel && success.ctaUrl ? (
        <Button asChild size="lg" className="mt-6 w-full sm:w-auto">
          <a href={success.ctaUrl}>{success.ctaLabel}</a>
        </Button>
      ) : null}
    </div>
  );
}
