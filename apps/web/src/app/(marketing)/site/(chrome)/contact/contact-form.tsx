"use client";

import { ArrowUpRight, CircleCheck } from "lucide-react";
import { useActionState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { REPLY_PROMISE } from "@/lib/marketing/site";
import { sendContactAction } from "./actions";
import { HONEYPOT_FIELD } from "./schema";

/**
 * The enquiry form. Five fields, one button, and a thank-you in place of
 * the form once it has gone — the page does not navigate, so the visitor
 * keeps the email address and phone number beside it.
 *
 * 16px fields at 44px tall, as on `/sign-in`: filled in on a phone by a
 * stranger, and 16px is what stops iOS zooming the page on focus.
 */
export function ContactForm({ page }: { page: string }) {
  const [state, formAction, pending] = useActionState(sendContactAction, null);

  if (state?.status === "ok") {
    return (
      <div role="status" className="rounded-2xl border border-success-border bg-success-bg p-6 text-success-fg">
        <div className="flex items-start gap-3">
          <CircleCheck aria-hidden className="mt-0.5 size-5 shrink-0" />
          <div>
            <p className="h-line">Thanks, your message is in.</p>
            <p className="mt-1 text-sm">{REPLY_PROMISE}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} aria-label="Contact" className="card space-y-6 p-6 sm:p-9">
      <input type="hidden" name="page" value={page} />
      {/* The honeypot: out of sight, out of the tab order, never announced. */}
      <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor={HONEYPOT_FIELD}>Company website</label>
        <input id={HONEYPOT_FIELD} name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="contact-name" label="Your name" name="name" autoComplete="name" required />
        <Field id="contact-email" label="Email" name="email" type="email" autoComplete="email" required />
        <Field id="contact-phone" label="Phone" name="phone" type="tel" autoComplete="tel" hint="Optional" />
        <Field id="contact-business" label="Business" name="business" autoComplete="organization" hint="Optional" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="contact-message" className="text-[0.9375rem] font-medium">
          What do you need?
        </Label>
        <Textarea
          id="contact-message"
          name="message"
          required
          rows={6}
          maxLength={4000}
          placeholder="A booking system for my salon, a new website, an app — a couple of lines is plenty."
          className="field"
        />
      </div>

      {state?.status === "error" ? (
        <InlineAlert tone="danger" title="Not sent">
          {state.message}
        </InlineAlert>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-[var(--mute)]">{REPLY_PROMISE} No mailing list, no follow-up sequence.</p>
        <Button type="submit" size="lg" loading={pending} className="btn btn-ink w-full sm:w-auto">
          Send message
          <ArrowUpRight aria-hidden className="arrow size-4" strokeWidth={2} />
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  name,
  type = "text",
  autoComplete,
  required,
  hint,
}: {
  id: string;
  label: string;
  name: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-[0.9375rem] font-medium">
        {label}
        {hint ? <span className="font-normal text-[var(--mute)]">{hint}</span> : null}
      </Label>
      <Input id={id} name={name} type={type} autoComplete={autoComplete} required={required} className="field" />
    </div>
  );
}
