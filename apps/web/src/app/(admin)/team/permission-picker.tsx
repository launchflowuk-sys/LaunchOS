"use client";

import { useState } from "react";

export type PermissionOption = { key: string; label: string };

/**
 * The permission boxes, as controls that actually post what you ticked.
 *
 * This replaces a Radix `Checkbox` per key, and the reason is a real bug: a
 * Radix checkbox is a `<button>` with a hidden `<input>` beside it, and inside
 * a server-action form that hidden input did not submit the state the user had
 * just set. Every key arrived absent, the action read absent as `false` for all
 * six, and the screen then redrew from the role defaults — so unticking one
 * box and saving appeared to "reset" the whole row to the coded defaults and
 * there was no way to narrow anybody. Nothing was wrong with the service: it
 * stores and reads a narrowed set correctly, which is why the fix is here.
 *
 * So: a plain `<input type="checkbox">` for the interaction, and — the part
 * that matters — an explicit hidden field per key carrying `on` or `off`.
 * Nothing depends on the browser's "unchecked boxes submit nothing" rule any
 * more, which is the rule every version of this bug has come through.
 */
export function PermissionPicker({
  idPrefix,
  options,
  initial,
  disabled = false,
}: {
  idPrefix: string;
  options: readonly PermissionOption[];
  /** What each key starts as. Missing keys start off. */
  initial: Record<string, boolean>;
  disabled?: boolean;
}) {
  const [granted, setGranted] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(options.map((option) => [option.key, initial[option.key] === true])),
  );

  return (
    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      {options.map((option) => {
        const id = `${idPrefix}-${option.key}`;
        const on = granted[option.key] === true;
        return (
          <div key={option.key} className="flex items-start gap-2">
            {/* The value the server reads. Always present, always explicit. */}
            <input type="hidden" name={option.key} value={on ? "on" : "off"} />
            <input
              id={id}
              type="checkbox"
              checked={on}
              disabled={disabled}
              onChange={(event) => setGranted((prev) => ({ ...prev, [option.key]: event.target.checked }))}
              className="mt-0.5 size-4 shrink-0 rounded-[4px] border-input accent-primary disabled:opacity-50"
            />
            <label htmlFor={id} className="text-sm leading-snug">
              {option.label}
            </label>
          </div>
        );
      })}
    </div>
  );
}
