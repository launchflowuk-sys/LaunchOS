"use client";

import * as React from "react"

import { cn } from "../../lib/utils.js"

/**
 * Fat, transparent, and found by its border.
 *
 * 48px tall with a 14px radius, per the commercial UI brief: nothing important
 * should look thin or frail. No fill — the border is the whole control, and on
 * focus it and its ring take the brand blue, so a focused field is unmistakable
 * without ever having had a background of its own.
 */

/**
 * What a phone keyboard should do for a given field.
 *
 * Two things a mobile form gets wrong by default and nobody notices on a
 * desktop. The keyboard opens on the wrong layout — letters for a phone number,
 * a full QWERTY for a number — and its bottom-right key says "Go", submitting a
 * half-filled form instead of moving to the next field. `inputMode` fixes the
 * first, `enterKeyHint` the second, and both are per-type facts rather than
 * something every call site should have to remember.
 *
 * `enterKeyHint: "next"` is the default for text-like fields, so the keyboard
 * advances. A submit-shaped field (search) says "search"; a password says "go",
 * because it is almost always the last field before signing in.
 */
const KEYBOARD: Record<string, { inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]; enterKeyHint?: string }> = {
  email: { inputMode: "email", enterKeyHint: "next" },
  tel: { inputMode: "tel", enterKeyHint: "next" },
  url: { inputMode: "url", enterKeyHint: "next" },
  number: { inputMode: "decimal", enterKeyHint: "next" },
  search: { inputMode: "search", enterKeyHint: "search" },
  password: { enterKeyHint: "go" },
};

/**
 * Enter moves to the next field instead of submitting a half-filled form.
 *
 * `enterKeyHint` only *labels* the key — the browser still submits when it is
 * pressed, which on a phone means a form is sent the moment somebody finishes
 * the first box. This walks the form's own elements to the next visible,
 * enabled control and focuses it; on the last one it does nothing and the
 * submit happens as it should.
 *
 * Textareas are left alone: Enter is a newline there, not navigation.
 */
function advanceOnEnter(event: React.KeyboardEvent<HTMLInputElement>): void {
  if (event.key !== "Enter" || event.shiftKey) return;
  const form = event.currentTarget.form;
  if (!form) return;

  const fields = Array.from(form.elements).filter(
    (el): el is HTMLInputElement | HTMLSelectElement =>
      (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) &&
      el.type !== "hidden" &&
      !el.disabled &&
      !(el instanceof HTMLInputElement && el.readOnly) &&
      el.offsetParent !== null,
  );
  const next = fields[fields.indexOf(event.currentTarget) + 1];
  if (!next) return; // Last field: let the form submit.

  event.preventDefault();
  next.focus();
  if (next instanceof HTMLInputElement && next.type !== "checkbox" && next.type !== "radio") next.select();
}

function Input({ className, type, inputMode, enterKeyHint, onKeyDown, ...props }: React.ComponentProps<"input">) {
  const keyboard = KEYBOARD[type ?? "text"] ?? { enterKeyHint: "next" };
  return (
    <input
      type={type}
      // An explicit prop always wins; this only fills the gap.
      inputMode={inputMode ?? keyboard.inputMode}
      enterKeyHint={(enterKeyHint ?? keyboard.enterKeyHint) as React.ComponentProps<"input">["enterKeyHint"]}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (!event.defaultPrevented) advanceOnEnter(event);
      }}
      data-slot="input"
      className={cn(
        "h-12 w-full min-w-0 rounded-[14px] border border-input bg-transparent px-3.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
