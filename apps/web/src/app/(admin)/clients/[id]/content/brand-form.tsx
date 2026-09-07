"use client";

import { useRef } from "react";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { BriefImageMode } from "../../../content/image-meta";
import { saveClientBrandAction } from "./actions";

/**
 * A colour, twice: the swatch to choose it with and the hex to paste into.
 *
 * Only the text box carries a `name`, so the form stays uncontrolled and posts
 * one value per colour. The two are kept in step by writing the other input's
 * `value` directly — a client picking their brand blue from a Figma file
 * pastes a hex, and Shoji on a phone uses the swatch, and neither should have
 * to know the other exists.
 */
function ColourField({
  name,
  label,
  hint,
  defaultValue,
}: {
  name: "primary" | "accent";
  label: string;
  hint: string;
  defaultValue: string;
}) {
  const hexId = `brand-${name}`;
  const swatch = useRef<HTMLInputElement>(null);
  const hex = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-1.5">
      <Label htmlFor={hexId}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          ref={swatch}
          type="color"
          defaultValue={defaultValue}
          aria-label={`${label} — colour picker`}
          className="h-8 w-12 shrink-0 cursor-pointer p-1"
          onChange={(event) => {
            if (hex.current) hex.current.value = event.target.value;
          }}
        />
        <Input
          ref={hex}
          id={hexId}
          name={name}
          defaultValue={defaultValue}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          placeholder="#0969ca"
          className="font-mono"
          onChange={(event) => {
            const value = event.target.value.trim();
            if (swatch.current && /^#[0-9a-fA-F]{6}$/.test(value)) swatch.current.value = value;
          }}
        />
      </div>
      <p className="text-meta text-muted-foreground">{hint}</p>
    </div>
  );
}

/**
 * How this client's post images look, and how they get made.
 *
 * One form and one Save, because it is one decision: the colours and wordmark
 * a branded graphic is drawn in, and whether we draw graphics at all or pay for
 * photographs. The logo is not here — it is one of the photos in the library
 * below, marked as the logo on its own tile.
 */
export function BrandForm({
  clientId,
  primary,
  accent,
  wordmark,
  wordmarkFallback,
  imageMode,
}: {
  clientId: string;
  primary: string;
  accent: string;
  /** The wordmark actually chosen, blank when none has been — so a rename still carries through. */
  wordmark: string;
  /** What is drawn when no wordmark has been chosen: the client's trading name. */
  wordmarkFallback: string;
  imageMode: BriefImageMode;
}) {
  return (
    <ActionForm
      action={saveClientBrandAction}
      ariaLabel="Brand and post images"
      success="Brand saved"
      className="grid gap-4 rounded-xl border bg-card p-4"
    >
      <input type="hidden" name="clientId" value={clientId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <ColourField
          name="primary"
          label="Primary colour"
          defaultValue={primary}
          hint="The ground a branded graphic is drawn on. Usually the darkest colour in the client's logo."
        />
        <ColourField
          name="accent"
          label="Accent colour"
          defaultValue={accent}
          hint="The rule above the headline, and anything that has to stand out against the primary."
        />
        <div className="space-y-1.5">
          <Label htmlFor="brand-wordmark">Wordmark</Label>
          <Input
            id="brand-wordmark"
            name="wordmark"
            defaultValue={wordmark}
            maxLength={60}
            placeholder={wordmarkFallback}
          />
          <p className="text-meta text-muted-foreground">
            The name set at the foot of a graphic. Leave blank to use &ldquo;{wordmarkFallback}&rdquo;, so a rename
            carries through on its own.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="brand-image-mode">Post images</Label>
          <NativeSelect key={imageMode} id="brand-image-mode" name="imageMode" defaultValue={imageMode}>
            <option value="template">Branded graphics</option>
            <option value="ai">AI photography</option>
          </NativeSelect>
          <p className="text-meta text-muted-foreground">
            Branded graphics are free and always available. AI photography costs money, is capped monthly, and falls
            back to a graphic when the cap is reached.
          </p>
        </div>
      </div>
      <div className="flex justify-end">
        <Button type="submit" className="max-sm:w-full">
          Save brand
        </Button>
      </div>
    </ActionForm>
  );
}
