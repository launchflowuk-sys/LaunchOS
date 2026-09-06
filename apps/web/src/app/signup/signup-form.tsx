"use client";

import { useActionState, useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { startSignupAction } from "./actions";

export type SignupPackage = {
  slug: string;
  name: string;
  description: string | null;
  monthlyPrice: string;
  setupPrice: string | null;
  /** True when the package sells through Stripe Checkout; false means "we'll invoice you". */
  online: boolean;
  includes: string[];
};

/**
 * The package cards and the details form, one submission. Cards are radio
 * inputs styled as cards — a keyboard and a screen reader see a choice, a
 * thumb sees a tile — and the chosen one is outlined in the brand blue.
 *
 * 16px fields at 44px tall, as on `/sign-in`: this is filled in on a phone
 * by someone who has never seen the product.
 */
export function SignupForm({ packages, initialSlug }: { packages: readonly SignupPackage[]; initialSlug: string | null }) {
  const [state, formAction, pending] = useActionState(startSignupAction, null);
  const [slug, setSlug] = useState(initialSlug ?? packages[0]?.slug ?? "");
  const chosen = packages.find((pkg) => pkg.slug === slug) ?? null;

  return (
    <form action={formAction} aria-label="Sign up" className="space-y-6">
      <fieldset>
        <legend className="mb-3 text-base font-semibold">1. Choose your package</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {packages.map((pkg) => {
            const selected = pkg.slug === slug;
            return (
              <label
                key={pkg.slug}
                className={cn(
                  "flex cursor-pointer flex-col rounded-xl border bg-card p-4 shadow-sm transition-colors has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
                  selected ? "border-primary ring-2 ring-primary/30" : "hover:border-muted-foreground/40",
                )}
              >
                <input
                  type="radio"
                  name="packageSlug"
                  value={pkg.slug}
                  checked={selected}
                  onChange={() => setSlug(pkg.slug)}
                  className="sr-only"
                />
                <span className="flex items-start justify-between gap-3">
                  <span className="text-base font-semibold">{pkg.name}</span>
                  <span className="text-base font-semibold tabular-nums">
                    {pkg.monthlyPrice}
                    <span className="text-meta font-normal text-muted-foreground"> / month</span>
                  </span>
                </span>
                {pkg.description ? <span className="mt-1 text-sm text-muted-foreground">{pkg.description}</span> : null}
                {pkg.includes.length > 0 ? (
                  <ul className="mt-3 space-y-1 text-sm">
                    {pkg.includes.map((line) => (
                      <li key={line} className="flex gap-2">
                        <span aria-hidden className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <span className="mt-3 text-meta text-muted-foreground">
                  {pkg.setupPrice ? `${pkg.setupPrice} set-up, then ` : ""}
                  {pkg.online ? "pay by card, cancel any time." : "we'll invoice you — no card needed today."}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="rounded-xl border bg-card p-5 shadow-sm sm:p-6">
        <legend className="px-1 text-base font-semibold">2. Your details</legend>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="signup-name">Your name</Label>
            <Input id="signup-name" name="name" autoComplete="name" required maxLength={120} className="h-11 bg-card text-base" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signup-business">Business name</Label>
            <Input id="signup-business" name="business" autoComplete="organization" required maxLength={200} className="h-11 bg-card text-base" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signup-email">Email</Label>
            <Input id="signup-email" name="email" type="email" inputMode="email" autoComplete="email" required maxLength={320} className="h-11 bg-card text-base" />
            <p className="text-meta text-muted-foreground">Your portal login goes here.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signup-phone">Phone (optional)</Label>
            <Input id="signup-phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={40} className="h-11 bg-card text-base" />
          </div>
        </div>

        {state?.status === "error" ? (
          <InlineAlert tone="danger" title="Could not start your sign-up" className="mt-4">
            {state.message}
          </InlineAlert>
        ) : null}

        <Button type="submit" size="lg" loading={pending} disabled={!chosen} className="mt-5 w-full">
          {chosen?.online === false ? "Sign up — invoice me" : "Continue to payment"}
        </Button>
        <p className="mt-3 text-center text-meta text-muted-foreground">
          {chosen?.online
            ? "Card payments are handled by Stripe. You will be back here the moment it is done."
            : "We will email your first invoice and your portal login."}
        </p>
      </fieldset>
    </form>
  );
}
