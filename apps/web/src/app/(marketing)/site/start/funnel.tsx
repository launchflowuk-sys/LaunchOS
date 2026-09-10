"use client";

import { ArrowLeft, ArrowRight, Check, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Field, type FieldDef } from "./fields";
import { useDraft } from "./use-draft";

/**
 * The eight-stage brief.
 *
 * The stages arrive as a prop from the server page, which owns the one shared
 * definition — the renderer, the validation and the brief mapping all read the
 * same config, so a field renamed on the form cannot leave the brief reading a
 * key nobody writes any more.
 *
 * What this component is careful about:
 *
 * - **A failed save never advances the step.** Continue waits for the writes
 *   to land, and the server decides whether the step is finished.
 * - **"Saved" is the server's word.** The indicator reads the save state from
 *   the hook, which only says saved after a committed response.
 * - **Every move puts the heading back on screen and in focus.** Without it,
 *   a tall step leaves the browser looking at the footer of the next one.
 */

export interface StageDef {
  step: number;
  key: string;
  title: string;
  blurb: string;
  fields: readonly FieldDef[];
}

function isActive(field: FieldDef, answers: Record<string, unknown>): boolean {
  if (!field.showWhen) return true;
  const parent = answers[field.showWhen.key];
  if (parent === undefined || parent === null || parent === "") return false;
  if (field.showWhen.hasAny.includes("*")) return true;
  const held = Array.isArray(parent) ? parent.map(String) : [String(parent)];
  return held.some((value) => field.showWhen!.hasAny.includes(value));
}

export function BriefFunnel({ stages }: { stages: readonly StageDef[] }) {
  const { session, ready, saveState, saveError, setField, flush, completeStep, retry } = useDraft();
  const [step, setStep] = useState(1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [direction, setDirection] = useState<1 | -1>(1);
  const [busy, setBusy] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  // Pick up where they left off, once, when the draft first arrives.
  useEffect(() => {
    if (session && !moved.current) {
      moved.current = true;
      setStep(session.currentStep);
    }
  }, [session]);

  /**
   * On every move: the top of the card back on screen, and the focus on the new
   * heading. The focus move is also what tells a screen reader the step
   * changed; `preventScroll` stops the two fighting each other.
   */
  useEffect(() => {
    if (!moved.current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  const stage = useMemo(() => stages.find((s) => s.step === step) ?? stages[0]!, [stages, step]);
  const answers = session?.answers ?? {};
  const visible = stage.fields.filter((field) => isActive(field, answers));
  const isReview = stage.key === "review";

  const go = (next: number) => {
    setDirection(next > step ? 1 : -1);
    setErrors({});
    setStep(next);
  };

  const onContinue = async () => {
    setBusy(true);
    try {
      const result = await completeStep(step);
      // A failed save must never advance. The errors land beside their fields
      // and the customer keeps everything they typed.
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      go(Math.min(step + 1, stages.length));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return (
      <div className="mx-auto grid min-h-[420px] w-full max-w-[720px] place-items-center" role="status">
        <Loader2 aria-hidden className="size-6 animate-spin text-[#626D80]" />
        <span className="sr-only">Loading your brief</span>
      </div>
    );
  }

  return (
    <div ref={card} className="mx-auto w-full max-w-[720px]">
      {/* Eight segments. Only steps the server has accepted are shown complete,
          and only those can be jumped back to. */}
      <nav aria-label="Progress" className="mb-7">
        <div className="mb-2.5 flex items-center justify-between">
          <p className="text-[13.5px] font-medium text-[#626D80]">
            Step {step} of {stages.length}
          </p>
          <SaveIndicator state={saveState} error={saveError} onRetry={() => void retry()} />
        </div>
        <ol className="flex gap-1.5">
          {stages.map((s) => {
            const done = (session?.completedSteps ?? []).includes(s.step);
            const here = s.step === step;
            return (
              <li key={s.key} className="flex-1">
                <button
                  type="button"
                  disabled={!done || here}
                  onClick={() => go(s.step)}
                  aria-current={here ? "step" : undefined}
                  aria-label={`Step ${s.step}: ${s.title}${done ? " (done)" : ""}`}
                  className={[
                    "h-1.5 w-full rounded-full transition disabled:cursor-default",
                    here ? "bg-[#0965EE]" : done ? "bg-[#0965EE]/45 hover:bg-[#0965EE]/70" : "bg-[#DFE4EB]",
                  ].join(" ")}
                />
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="rounded-[24px] border border-[#DFE4EB] bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,.04),0_24px_48px_-24px_rgba(16,24,40,.14)] sm:p-9">
        <div key={stage.key} data-step-enter={direction === 1 ? "forward" : "back"}>
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-[30px] font-semibold leading-[1.15] tracking-[-0.8px] text-[#111827] outline-none sm:text-[38px] sm:tracking-[-1.6px]"
          >
            {stage.title}
          </h1>
          <p className="mt-2 text-[15.5px] leading-relaxed text-[#626D80]">{stage.blurb}</p>

          {isReview ? (
            <Review stages={stages} answers={answers} onEdit={go} />
          ) : (
            <div className="mt-8 space-y-7">
              {visible.map((field) => (
                <Field
                  key={field.key}
                  field={field}
                  value={answers[field.key]}
                  error={errors[field.key]}
                  onChange={(value) => setField(field.key, value)}
                  onBlur={() => void flush()}
                />
              ))}
            </div>
          )}
        </div>

        <div className="mt-9 flex items-center justify-between gap-3 border-t border-[#DFE4EB] pt-6">
          <button
            type="button"
            onClick={() => go(Math.max(1, step - 1))}
            disabled={step === 1 || busy}
            className={[
              "inline-flex min-h-[51px] items-center gap-2 rounded-[12px] px-4 text-[15px] font-medium text-[#626D80]",
              "transition hover:bg-[#F5F6F8] hover:text-[#111827] disabled:opacity-0",
            ].join(" ")}
          >
            <ArrowLeft aria-hidden className="size-4" /> Back
          </button>

          <button
            type="button"
            onClick={() => void onContinue()}
            disabled={busy}
            className={[
              "inline-flex min-h-[51px] items-center gap-2 rounded-[12px] bg-[#0965EE] px-6 text-[15.5px] font-semibold text-white",
              "transition hover:bg-[#0457D3] focus:outline-none focus-visible:ring-4 focus-visible:ring-[#0965EE]/30 disabled:opacity-60",
            ].join(" ")}
          >
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
            {isReview ? "Send my brief" : "Save & continue"}
            {!busy && !isReview ? <ArrowRight aria-hidden className="size-4" /> : null}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The header status.
 *
 * "Saved" appears only when the hook says the server committed. A failure is
 * amber with a Retry rather than a red wall, because nothing has been lost —
 * the answer is still in the field and still queued.
 */
function SaveIndicator({ state, error, onRetry }: { state: string; error: string | null; onRetry: () => void }) {
  if (state === "error") {
    return (
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-[#94620B]" role="alert">
        <TriangleAlert aria-hidden className="size-3.5" />
        {error ?? "Not saved"}
        <button type="button" onClick={onRetry} className="underline underline-offset-2 hover:text-[#111827]">
          Retry
        </button>
      </p>
    );
  }
  return (
    <p aria-live="polite" className="flex items-center gap-1.5 text-[13px] text-[#626D80]">
      {state === "saving" ? (
        <>
          <Loader2 aria-hidden className="size-3.5 animate-spin" /> Saving…
        </>
      ) : state === "saved" ? (
        <>
          <Check aria-hidden className="size-3.5 text-[#26905D]" /> Saved
        </>
      ) : null}
    </p>
  );
}

/** Everything they said, grouped by stage, each with a way back to it. */
function Review({
  stages, answers, onEdit,
}: { stages: readonly StageDef[]; answers: Record<string, unknown>; onEdit: (step: number) => void }) {
  return (
    <div className="mt-8 space-y-5">
      {stages
        .filter((stage) => stage.key !== "review")
        .map((stage) => {
          const rows = stage.fields
            .filter((field) => isActive(field, answers))
            .map((field) => ({ field, value: answers[field.key] }))
            .filter(({ value }) => !(value === undefined || value === "" || (Array.isArray(value) && value.length === 0)));

          return (
            <section key={stage.key} className="rounded-[16px] border border-[#DFE4EB] p-5">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-[16px] font-semibold text-[#111827]">{stage.title}</h2>
                <button
                  type="button"
                  onClick={() => onEdit(stage.step)}
                  className="text-[14px] font-medium text-[#0965EE] underline-offset-2 hover:underline"
                >
                  Edit<span className="sr-only"> {stage.title}</span>
                </button>
              </div>
              {rows.length === 0 ? (
                <p className="text-[14px] text-[#626D80]">To be confirmed</p>
              ) : (
                <dl className="space-y-2.5">
                  {rows.map(({ field, value }) => (
                    <div key={field.key} className="flex flex-wrap gap-x-5 gap-y-0.5">
                      <dt className="w-44 shrink-0 text-[13.5px] text-[#626D80]">{field.label}</dt>
                      <dd className="min-w-0 flex-1 text-[14.5px] whitespace-pre-line text-[#111827]">
                        {readable(field, value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          );
        })}
    </div>
  );
}

/** The words the customer saw, not the values we stored. */
function readable(field: FieldDef, value: unknown): string {
  const label = (raw: string) => field.options?.find((option) => option.value === raw)?.label ?? raw;
  if (Array.isArray(value)) return value.map((entry) => label(String(entry))).join(", ");
  return label(String(value ?? ""));
}
