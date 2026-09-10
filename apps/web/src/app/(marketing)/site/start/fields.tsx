"use client";

import { Check } from "lucide-react";
import { useId } from "react";
import { UploadField } from "./upload-field";

/**
 * One renderer per kind of question.
 *
 * The shapes are declared here rather than imported from `@launchos/core`: this
 * is a client component, and a value import from core pulls the database driver
 * into the browser bundle. The server page owns the config and hands it down.
 *
 * Everything is a real labelled input with real checkbox or radio semantics.
 * Choice cards are `<label>` wrapping a visually-hidden control, so keyboard,
 * screen reader and browser autofill all behave, and the tick is never the only
 * thing saying a card is chosen.
 */

export interface FieldOption {
  value: string;
  label: string;
  hint?: string;
}

export interface FieldDef {
  key: string;
  label: string;
  kind: "text" | "email" | "tel" | "textarea" | "select" | "single" | "multi" | "chips" | "date" | "upload";
  hint?: string;
  placeholder?: string;
  required?: boolean;
  options?: readonly FieldOption[];
  maxLength?: number;
  autoComplete?: string;
  showWhen?: { key: string; hasAny: readonly string[] };
  /** Sits beside its neighbour on desktop. Laid out by the shell, not here. */
  half?: boolean;
}

interface FieldProps {
  field: FieldDef;
  value: unknown;
  error?: string | undefined;
  onChange: (value: unknown) => void;
  /** Saves on blur as well as on the debounce — a field left focused still lands. */
  onBlur: () => void;
}

const INPUT =
  "min-h-[53px] w-full rounded-[13px] border border-[#DFE4EB] bg-[#FAFBFC] px-4 text-[16px] text-[#111827] " +
  "outline-none transition placeholder:text-[#98A2B3] focus:border-[#0965EE] focus:bg-white focus:ring-4 focus:ring-[#0965EE]/12";

export function Field({ field, value, error, onChange, onBlur }: FieldProps) {
  const id = useId();
  const describedBy = [field.hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");

  const shared = {
    id,
    name: field.key,
    "aria-invalid": error ? true : undefined,
    "aria-describedby": describedBy || undefined,
    onBlur,
  } as const;

  return (
    <div className="space-y-2">
      {/* A legend for grouped controls, a label for single ones — the two are
          not interchangeable to a screen reader. */}
      {["single", "multi", "chips", "upload"].includes(field.kind) ? null : (
        <label htmlFor={id} className="block text-[15px] font-medium text-[#111827]">
          {field.label}
          {field.required ? <span className="ml-1 text-[#B43A34]" aria-hidden>*</span> : null}
        </label>
      )}

      {field.hint && field.kind !== "upload" ? (
        <p id={`${id}-hint`} className="text-[13.5px] leading-snug text-[#626D80]">
          {field.hint}
        </p>
      ) : null}

      {field.kind === "textarea" ? (
        <textarea
          {...shared}
          rows={4}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          className={`${INPUT} py-3 leading-relaxed`}
        />
      ) : null}

      {["text", "email", "tel", "date"].includes(field.kind) ? (
        <input
          {...shared}
          type={field.kind === "date" ? "date" : field.kind}
          inputMode={field.kind === "tel" ? "tel" : undefined}
          autoComplete={field.autoComplete}
          maxLength={field.maxLength}
          placeholder={field.placeholder}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.target.value)}
          className={INPUT}
        />
      ) : null}

      {field.kind === "single" ? (
        <ChoiceGroup field={field} value={value} error={error} onChange={onChange} onBlur={onBlur} multiple={false} />
      ) : null}

      {field.kind === "multi" ? (
        <ChoiceGroup field={field} value={value} error={error} onChange={onChange} onBlur={onBlur} multiple />
      ) : null}

      {field.kind === "chips" ? <Chips field={field} value={value} error={error} onChange={onChange} /> : null}

      {/* Attachments are not an answer on the draft — they are rows of their
          own, so the field renders its own uploader rather than taking a
          value. */}
      {field.kind === "upload" ? <UploadField label={field.label} hint={field.hint} /> : null}

      {error ? (
        <p id={`${id}-error`} className="text-[13.5px] font-medium text-[#B43A34]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Cards, one tap each.
 *
 * `multiple` decides checkbox or radio, and the control is real and focusable —
 * hidden with `sr-only` rather than `display:none`, which would take it out of
 * the tab order and off the accessibility tree.
 */
function ChoiceGroup({
  field, value, error, onChange, onBlur, multiple,
}: FieldProps & { multiple: boolean }) {
  const name = useId();
  const selected = multiple
    ? new Set(Array.isArray(value) ? value.map(String) : [])
    : new Set(typeof value === "string" && value ? [value] : []);

  const toggle = (option: string) => {
    if (!multiple) {
      onChange(option);
    } else {
      const next = new Set(selected);
      if (next.has(option)) next.delete(option);
      else next.add(option);
      onChange([...next]);
    }
    onBlur();
  };

  return (
    <fieldset className="mt-1">
      <legend className="mb-3 block text-[15px] font-medium text-[#111827]">
        {field.label}
        {field.required ? <span className="ml-1 text-[#B43A34]" aria-hidden>*</span> : null}
      </legend>
      <div className="grid grid-cols-1 gap-[13px] sm:grid-cols-2">
        {(field.options ?? []).map((option) => {
          const isOn = selected.has(option.value);
          return (
            <label
              key={option.value}
              className={[
                "relative flex min-h-[92px] cursor-pointer flex-col justify-center gap-1 rounded-[16px] border p-4 transition",
                "focus-within:ring-4 focus-within:ring-[#0965EE]/20",
                isOn ? "border-[#0965EE] bg-[#F0F6FF]" : "border-[#DFE4EB] bg-white hover:border-[#B9C4D2]",
              ].join(" ")}
            >
              <input
                type={multiple ? "checkbox" : "radio"}
                name={multiple ? `${name}-${option.value}` : name}
                value={option.value}
                checked={isOn}
                onChange={() => toggle(option.value)}
                className="sr-only"
                aria-invalid={error ? true : undefined}
              />
              <span className="flex items-center gap-2 pr-6 text-[15.5px] font-semibold text-[#111827]">
                {option.label}
              </span>
              {option.hint ? <span className="text-[13px] leading-snug text-[#626D80]">{option.hint}</span> : null}
              {/* The tick is the confirmation; the border and fill carry it too,
                  so colour is never the only signal. */}
              {isOn ? (
                <span aria-hidden className="absolute right-3.5 top-3.5 grid size-6 place-items-center rounded-full bg-[#0965EE] text-white">
                  <Check className="size-3.5" strokeWidth={3} />
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Compact multi-select for long flat lists — pages, timeframes. */
function Chips({ field, value, error, onChange }: Omit<FieldProps, "onBlur">) {
  const name = useId();
  const selected = new Set(Array.isArray(value) ? value.map(String) : []);

  return (
    <fieldset>
      <legend className="mb-3 block text-[15px] font-medium text-[#111827]">
        {field.label}
        {field.required ? <span className="ml-1 text-[#B43A34]" aria-hidden>*</span> : null}
      </legend>
      <div className="flex flex-wrap gap-2.5">
        {(field.options ?? []).map((option) => {
          const isOn = selected.has(option.value);
          return (
            <label
              key={option.value}
              className={[
                "cursor-pointer rounded-full border px-4 py-2.5 text-[14.5px] font-medium transition",
                "focus-within:ring-4 focus-within:ring-[#0965EE]/20",
                isOn ? "border-[#0965EE] bg-[#0965EE] text-white" : "border-[#DFE4EB] bg-white text-[#111827] hover:border-[#B9C4D2]",
              ].join(" ")}
            >
              <input
                type="checkbox"
                name={`${name}-${option.value}`}
                checked={isOn}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(option.value)) next.delete(option.value);
                  else next.add(option.value);
                  onChange([...next]);
                }}
                className="sr-only"
                aria-invalid={error ? true : undefined}
              />
              {isOn ? <Check aria-hidden className="mr-1.5 inline size-3.5" strokeWidth={3} /> : null}
              {option.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
