"use client";

import { Check, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * "Save & exit" — a link back, sent on request.
 *
 * It used to render the panel *instead of* the button, anchored to the right
 * edge inside an 83px header. On a phone that put a 320px panel half off the
 * screen with no way to shut it, so tapping it looked like nothing happened —
 * which is exactly what was reported. Now the button stays put, the panel is a
 * proper dialog, and on a narrow screen it is centred rather than hung off one
 * corner.
 *
 * The link itself only ever goes out on request. There is no abandoned-draft
 * chase here: somebody who walks away has not asked to hear from us, and an
 * unsolicited "you left something behind" is how a domain earns a reputation.
 *
 * The reply is the same whether or not a draft was found for that address, so
 * this cannot be used to ask whether a business has a project with us.
 */
export function SaveExit({ defaultEmail }: { defaultEmail: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(defaultEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // A dialog that cannot be dismissed is a trap. Escape, a close button, and a
  // click anywhere else all shut it, and focus goes back where it came from.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || trigger.current?.contains(target)) return;
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  });

  function close() {
    setOpen(false);
    setSent(false);
    trigger.current?.focus();
  }

  const send = async () => {
    setBusy(true);
    await fetch("/api/brief-funnel/resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }).catch(() => undefined);
    setBusy(false);
    setSent(true);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="text-[14.5px] font-semibold text-[#0965EE] hover:underline"
      >
        Save &amp; exit
      </button>

      {open ? (
        <>
          {/* On a phone this is a centred card over a dimmed page, because a
              panel pinned to the corner of a short header falls off the screen.
              From `sm` up it sits under the button as a dropdown. */}
          <div className="fixed inset-0 z-40 bg-[#16202E]/35 sm:hidden" aria-hidden />
          <div
            ref={panel}
            role="dialog"
            aria-label="Come back to this later"
            className={[
              "fixed left-1/2 top-1/2 z-50 w-[min(360px,calc(100vw-2.5rem))] -translate-x-1/2 -translate-y-1/2",
              "sm:absolute sm:left-auto sm:right-0 sm:top-full sm:mt-2 sm:translate-x-0 sm:translate-y-0 sm:w-[340px]",
              "rounded-[16px] border border-[#DFE4EB] bg-white p-5 text-left",
              "shadow-[0_18px_44px_-16px_rgba(16,32,46,.4)]",
            ].join(" ")}
          >
            <button
              type="button"
              onClick={close}
              aria-label="Close"
              className="absolute right-3 top-3 rounded-full p-1.5 text-[#626D80] transition hover:bg-[#F1F3F6] hover:text-[#111827]"
            >
              <X aria-hidden className="size-4" />
            </button>

            {sent ? (
              <>
                <p className="flex items-start gap-2 pr-6 text-[14.5px] leading-relaxed text-[#111827]">
                  <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-[#26905D]" />
                  If we have a brief for that address, a link back to it is on its way. It works once and
                  lasts 48 hours.
                </p>
                <button
                  type="button"
                  onClick={close}
                  className="mt-4 inline-flex min-h-[44px] w-full items-center justify-center rounded-[11px] bg-[#F1F3F6] text-[14.5px] font-semibold text-[#3D4757] transition hover:bg-[#E6EAF0]"
                >
                  Close
                </button>
              </>
            ) : (
              <>
                <p className="pr-6 text-[14.5px] font-semibold text-[#111827]">Come back to this later</p>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-[#626D80]">
                  Everything is already saved. We can email you a link straight back to it.
                </p>
                <label htmlFor="resume-email" className="mt-3 block text-[13.5px] font-medium text-[#111827]">
                  Your email
                </label>
                <input
                  id="resume-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="mt-1.5 min-h-[44px] w-full rounded-[11px] border border-[#DFE4EB] bg-[#FAFBFC] px-3 text-[16px] outline-none focus:border-[#0965EE] focus:bg-white"
                />
                <button
                  type="button"
                  onClick={() => void send()}
                  disabled={busy || !email.includes("@")}
                  className="mt-3 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-[11px] bg-[#0965EE] text-[14.5px] font-semibold text-white transition hover:bg-[#0457D3] disabled:opacity-60"
                >
                  {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
                  Email me the link
                </button>
              </>
            )}
          </div>
        </>
      ) : null}
    </>
  );
}
