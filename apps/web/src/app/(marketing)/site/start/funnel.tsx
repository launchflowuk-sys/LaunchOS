"use client";

import { ArrowRight, Check, Loader2, TriangleAlert } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { Field, type FieldDef } from "./fields";
import { useDraft } from "./use-draft";

/**
 * The eight-stage brief, laid out as the handoff draws it.
 *
 * Two compositions, not one. **Stage one** is the front door: an editorial
 * column on the left — headline, promise, a mock of the thing they are here to
 * buy — beside the form. **Every stage after it** drops the editorial and puts
 * a 320px "Your brief so far" column there instead, which fills in as they
 * answer. That swap is the whole trick: the left half sells before there is
 * anything to show, and reports once there is.
 *
 * The stages arrive as a prop from the server page, which owns the one shared
 * definition. A client component that value-imports `@launchos/core` drags the
 * database driver into the browser bundle.
 */

export interface StageDef {
  step: number;
  key: string;
  navLabel: string;
  eyebrow: string;
  title: string;
  blurb: string;
  nextHint?: string;
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
  const top = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (session && !moved.current) {
      moved.current = true;
      setStep(session.currentStep);
    }
  }, [session]);

  /**
   * Every move: the top of the page back on screen, focus on the new heading.
   * The focus move is also what tells a screen reader the step changed;
   * `preventScroll` stops the two fighting.
   */
  useEffect(() => {
    if (!moved.current) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    top.current?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  const stage = useMemo(() => stages.find((s) => s.step === step) ?? stages[0]!, [stages, step]);
  const answers = session?.answers ?? {};
  const visible = stage.fields.filter((field) => isActive(field, answers));
  const isIntro = stage.step === 1;
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
      // A failed save never advances. Errors land beside their own fields and
      // the customer keeps every word they typed.
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
      <div className="grid min-h-[60vh] place-items-center" role="status">
        <Loader2 aria-hidden className="size-6 animate-spin text-[#626D80]" />
        <span className="sr-only">Loading your brief</span>
      </div>
    );
  }

  return (
    <div ref={top} className="mx-auto w-full max-w-[1280px] px-5 sm:px-[26px] lg:px-[42px]">
      <FunnelHeader state={saveState} error={saveError} onRetry={() => void retry()} />

      <div className="mt-7 flex items-end justify-between gap-4">
        <p className="text-[17px] font-semibold tracking-[-0.3px] text-[#111827]">Your website, made for you.</p>
        <p className="shrink-0 text-[13.5px] text-[#626D80]">
          Step {step} of {stages.length}
        </p>
      </div>

      <Stepper stages={stages} step={step} completed={session?.completedSteps ?? []} onJump={go} />

      <div
        className={[
          "mt-8 grid gap-[26px] pb-16",
          isIntro ? "lg:grid-cols-[0.77fr_1.23fr]" : "lg:grid-cols-[1fr_320px]",
        ].join(" ")}
      >
        {/* On the intro the editorial comes first in the source too, because it
            is the thing that explains the form to somebody who just arrived. */}
        {isIntro ? <Editorial /> : null}

        <div key={stage.key} data-step-enter={direction === 1 ? "forward" : "back"}>
          <div className="rounded-[24px] border border-[#DFE4EB] bg-white p-6 shadow-[0_1px_2px_rgba(16,24,40,.04),0_18px_44px_-28px_rgba(16,24,40,.22)] sm:p-9">
            <p className="text-[12px] font-semibold tracking-[0.12em] text-[#8A94A6]">{stage.eyebrow}</p>
            <h1
              ref={heading}
              tabIndex={-1}
              className="mt-2.5 text-[30px] font-semibold leading-[1.12] tracking-[-1px] text-[#111827] outline-none sm:text-[38px] sm:tracking-[-1.6px]"
            >
              {stage.title}
            </h1>
            <p className="mt-2.5 text-[15.5px] leading-relaxed text-[#626D80]">{stage.blurb}</p>

            {/* The collection notice sits above the first field, before anybody
                types — not in small print underneath after they already have. */}
            {isIntro ? (
              <p className="mt-4 rounded-[12px] bg-[#F5F6F8] px-4 py-3 text-[13px] leading-relaxed text-[#626D80]">
                We save the details you enter so you can come back later and so we can contact you about this project.{" "}
                <Link href="/privacy" className="text-[#0965EE] underline underline-offset-2">
                  Privacy policy
                </Link>
                .
              </p>
            ) : null}

            {isReview ? (
              <Review stages={stages} answers={answers} onEdit={go} />
            ) : (
              <div className="mt-7 grid grid-cols-1 gap-x-5 gap-y-6 sm:grid-cols-2">
                {visible.map((field) => (
                  <div key={field.key} className={field.half ? "sm:col-span-1" : "sm:col-span-2"}>
                    <Field
                      field={field}
                      value={answers[field.key]}
                      error={errors[field.key]}
                      onChange={(value) => setField(field.key, value)}
                      onBlur={() => void flush()}
                    />
                  </div>
                ))}
              </div>
            )}

            <p className="mt-7 text-[13px] text-[#626D80]">Finish at your own pace. Your answers are saved as you go.</p>

            <div className="mt-4 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => go(Math.max(1, step - 1))}
                disabled={step === 1 || busy}
                className={[
                  "inline-flex min-h-[51px] items-center gap-2 rounded-[12px] bg-[#F1F3F6] px-5 text-[15px] font-medium text-[#3D4757]",
                  "transition hover:bg-[#E6EAF0] disabled:invisible",
                ].join(" ")}
              >
                ← Back
              </button>

              <button
                type="button"
                onClick={() => void onContinue()}
                disabled={busy}
                className={[
                  "inline-flex min-h-[51px] flex-1 items-center justify-center gap-2.5 rounded-[12px] bg-[#0965EE] px-6 text-[15.5px] font-semibold text-white sm:flex-none sm:min-w-[240px]",
                  "transition hover:bg-[#0457D3] focus:outline-none focus-visible:ring-4 focus-visible:ring-[#0965EE]/30 disabled:opacity-60",
                ].join(" ")}
              >
                {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
                {isReview ? "Send my brief" : "Save & continue"}
                {!busy && !isReview ? <ArrowRight aria-hidden className="size-4" /> : null}
              </button>
            </div>

            {stage.nextHint ? (
              <p className="mt-3 text-right text-[13px] text-[#98A2B3]">{stage.nextHint}</p>
            ) : null}
          </div>
        </div>

        {/* The brief fills in as they answer. Never invents: anything unknown
            reads "Still to explore" rather than a plausible guess. */}
        {!isIntro ? <BriefSoFar stages={stages} answers={answers} /> : null}
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[#DFE4EB] py-6 text-[13px] text-[#8A94A6]">
        <p>© LaunchFlow · Built around your business.</p>
        <p className="flex gap-4">
          <Link href="/privacy" className="hover:text-[#111827]">Privacy</Link>
          <Link href="/contact" className="hover:text-[#111827]">Need a hand?</Link>
        </p>
      </footer>
    </div>
  );
}

/** Logo, save status, and a way out that does not lose anything. */
function FunnelHeader({ state, error, onRetry }: { state: string; error: string | null; onRetry: () => void }) {
  return (
    <header className="flex h-[83px] items-center justify-between gap-4 border-b border-[#DFE4EB] sm:h-[108px]">
      <Link href="/" aria-label="LaunchFlow home">
        <Image
          src="/brand/launchflow-logo-transparent@600.png"
          alt="LaunchFlow"
          width={188}
          height={42}
          priority
          className="h-auto w-[146px] sm:w-[188px]"
        />
      </Link>
      <div className="flex items-center gap-4">
        <SaveIndicator state={state} error={error} onRetry={onRetry} />
        <Link href="/contact" className="text-[14.5px] font-semibold text-[#0965EE] hover:underline">
          Save &amp; exit
        </Link>
      </div>
    </header>
  );
}

/**
 * Eight segments with their names under them.
 *
 * Only steps the server has accepted are shown complete, and only those can be
 * jumped back to — a client that decides for itself which steps are done is a
 * client that can skip validation by editing its own state.
 */
function Stepper({
  stages, step, completed, onJump,
}: { stages: readonly StageDef[]; step: number; completed: number[]; onJump: (step: number) => void }) {
  return (
    <nav aria-label="Progress" className="mt-4">
      <ol className="flex gap-2 sm:gap-3">
        {stages.map((s) => {
          const done = completed.includes(s.step);
          const here = s.step === step;
          return (
            <li key={s.key} className="min-w-0 flex-1">
              <button
                type="button"
                disabled={!done || here}
                onClick={() => onJump(s.step)}
                aria-current={here ? "step" : undefined}
                aria-label={`Step ${s.step}: ${s.navLabel}${done ? " (done)" : ""}`}
                className="block w-full text-left disabled:cursor-default"
              >
                <span
                  aria-hidden
                  className={[
                    "block h-[3px] w-full rounded-full transition",
                    here || done ? "bg-[#0965EE]" : "bg-[#DFE4EB]",
                  ].join(" ")}
                />
                <span
                  aria-hidden
                  className={[
                    "mt-2.5 hidden truncate text-[12.5px] lg:block",
                    here ? "font-semibold text-[#0965EE]" : "text-[#626D80]",
                  ].join(" ")}
                >
                  {s.navLabel}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The left half of the front door.
 *
 * The cascading mock is CSS, not an image: it has to sit on the page's own
 * ground at any width, and a flat PNG of a fake browser would be a fixed size
 * and the wrong colour the first time the palette moved. Decorative throughout,
 * so it is hidden from the accessibility tree — it says nothing a screen reader
 * user needs, and the headline beside it already said it.
 */
function Editorial() {
  return (
    <div className="hidden lg:block">
      <p className="text-[12.5px] font-semibold tracking-[0.16em] text-[#8A94A6]">LET&rsquo;S BUILD SOMETHING</p>
      <h2 className="mt-5 text-[52px] font-semibold leading-[1.02] tracking-[-2.4px] text-[#111827]">
        Big ideas.
        <br />
        Better websites.
      </h2>
      <p className="mt-5 max-w-[380px] text-[16.5px] leading-relaxed text-[#626D80]">
        A few simple steps to turn what&rsquo;s in your head into a website that works for your business.
      </p>

      <div aria-hidden className="relative mt-10 h-[230px] w-full max-w-[380px]">
        {/* Three panes, each further back and further turned, so it reads as a
            stack of pages rather than one flat card. */}
        <div className="absolute left-6 top-7 h-[170px] w-[300px] -rotate-[7deg] rounded-[18px] bg-[#DCE9FF]" />
        <div className="absolute left-3 top-4 h-[170px] w-[300px] -rotate-[4deg] rounded-[18px] bg-[#EDF4FF] shadow-sm" />
        <div className="absolute left-0 top-0 h-[176px] w-[304px] -rotate-[1.5deg] rounded-[18px] border border-[#E6EBF2] bg-white p-5 shadow-[0_18px_40px_-20px_rgba(16,24,40,.28)]">
          <div className="mb-4 h-1.5 w-24 rounded-full bg-[#E6EBF2]" />
          <p className="text-[19px] font-semibold leading-tight tracking-[-0.6px] text-[#111827]">
            Your business.
            <br />
            Beautifully online.
          </p>
          <div className="mt-4 h-9 w-[72%] rounded-[10px] bg-gradient-to-r from-[#CFE2FF] to-[#EAF2FF]" />
        </div>
      </div>

      <ul className="mt-9 space-y-3.5">
        {["Start with your details", "Finish at your own pace", "A clear plan, built around you"].map((line) => (
          <li key={line} className="flex items-center gap-3 text-[14.5px] text-[#3D4757]">
            <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full bg-[#E4EEFF] text-[#0965EE]">
              <Check className="size-3.5" strokeWidth={3} />
            </span>
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What we know so far, in their words.
 *
 * Only from answers the server acknowledged, and never filled in: a gap reads
 * "Still to explore". A sidebar that guessed at a business name would be the
 * one part of this journey the customer could catch us making things up in.
 */
function BriefSoFar({ stages, answers }: { stages: readonly StageDef[]; answers: Record<string, unknown> }) {
  const label = (key: string, raw: unknown): string => {
    const field = stages.flatMap((s) => s.fields).find((f) => f.key === key);
    const one = (value: string) => field?.options?.find((option) => option.value === value)?.label ?? value;
    if (Array.isArray(raw)) return raw.map((entry) => one(String(entry))).join(", ");
    return one(String(raw ?? ""));
  };
  const has = (key: string) => {
    const value = answers[key];
    return value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
  };

  return (
    <aside className="lg:sticky lg:top-6 lg:self-start">
      <div className="rounded-[24px] border border-[#DFE4EB] bg-white p-6">
        <h2 className="text-[19px] font-semibold tracking-[-0.4px] text-[#111827]">Your brief so far</h2>
        <p className="mt-1.5 flex items-center gap-2 text-[13px] text-[#26905D]">
          <span aria-hidden className="size-2 rounded-full bg-[#26905D]" />
          Saved automatically
        </p>

        <Block title="CONTACT">
          {has("name") ? <p className="text-[15px] font-semibold text-[#111827]">{label("name", answers.name)}</p> : null}
          {has("email") ? <p className="text-[14px] text-[#626D80]">{label("email", answers.email)}</p> : null}
          {has("phone") ? <p className="text-[14px] text-[#626D80]">{label("phone", answers.phone)}</p> : null}
          {!has("name") && !has("email") && !has("phone") ? <Unknown /> : null}
        </Block>

        <Block title="BUSINESS">
          {has("business") ? <p className="text-[15px] font-semibold text-[#111827]">{label("business", answers.business)}</p> : null}
          {has("industry") ? <p className="text-[14px] text-[#626D80]">{label("industry", answers.industry)}</p> : null}
          {!has("business") && !has("industry") ? <Unknown /> : null}
        </Block>

        <Block title="MAIN GOALS">
          {has("goals") ? (
            <div className="flex flex-wrap gap-2">
              {(answers.goals as string[]).map((goal) => (
                <span key={goal} className="rounded-full bg-[#EDF4FF] px-3 py-1.5 text-[13px] font-medium text-[#0965EE]">
                  {label("goals", goal)}
                </span>
              ))}
            </div>
          ) : (
            <Unknown />
          )}
        </Block>

        {has("designDirection") || has("budget") ? (
          <Block title="DIRECTION">
            {has("designDirection") ? <p className="text-[14px] text-[#111827]">{label("designDirection", answers.designDirection)}</p> : null}
            {has("budget") ? <p className="text-[14px] text-[#626D80]">{label("budget", answers.budget)}</p> : null}
          </Block>
        ) : null}

        <p className="mt-5 rounded-[14px] bg-[#F5F6F8] p-4 text-[13px] leading-relaxed text-[#626D80]">
          Taking shape, step by step. Your answers become a clear brief for your new website.
        </p>
      </div>
    </aside>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 border-t border-[#EDF0F4] pt-4">
      <h3 className="mb-2 text-[11.5px] font-semibold tracking-[0.12em] text-[#8A94A6]">{title}</h3>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Unknown() {
  return <p className="text-[14px] italic text-[#98A2B3]">Still to explore</p>;
}

/** The header's save status. "Saved" only after a committed response. */
function SaveIndicator({ state, error, onRetry }: { state: string; error: string | null; onRetry: () => void }) {
  if (state === "error") {
    return (
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-[#94620B]" role="alert">
        <TriangleAlert aria-hidden className="size-3.5" />
        <span className="hidden sm:inline">{error ?? "Not saved"}</span>
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
          <Check aria-hidden className="size-3.5 text-[#26905D]" /> Progress saved
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
    <div className="mt-7 space-y-4">
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
                      <dd className="min-w-0 flex-1 whitespace-pre-line text-[14.5px] text-[#111827]">
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
