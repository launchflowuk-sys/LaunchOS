"use client";

import { Check, Loader2 } from "lucide-react";
import { useState } from "react";

/**
 * "Save & exit" — a link back, sent on request.
 *
 * Only ever on request. There is no abandoned-draft chase here: somebody who
 * walks away has not asked to hear from us, and an unsolicited "you left
 * something behind" email is the kind of thing that gets a domain a reputation.
 *
 * The reply is the same whether or not a draft was found for that address, so
 * this cannot be used to ask whether a business has a project with us.
 */
export function SaveExit({ defaultEmail }: { defaultEmail: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState(defaultEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

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

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[14.5px] font-semibold text-[#0965EE] hover:underline"
      >
        Save &amp; exit
      </button>
    );
  }

  return (
    <div className="absolute right-0 top-full z-20 mt-2 w-[320px] rounded-[16px] border border-[#DFE4EB] bg-white p-5 text-left shadow-[0_18px_44px_-20px_rgba(16,24,40,.28)]">
      {sent ? (
        <p className="flex items-start gap-2 text-[14px] leading-relaxed text-[#111827]">
          <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-[#26905D]" />
          If we have a brief for that address, a link back to it is on its way. It works once and lasts 48
          hours.
        </p>
      ) : (
        <>
          <p className="text-[14px] font-semibold text-[#111827]">Come back to this later</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-[#626D80]">
            Everything is already saved. We can email you a link straight back to it.
          </p>
          <label htmlFor="resume-email" className="mt-3 block text-[13px] font-medium text-[#111827]">
            Your email
          </label>
          <input
            id="resume-email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1.5 min-h-[44px] w-full rounded-[11px] border border-[#DFE4EB] bg-[#FAFBFC] px-3 text-[15px] outline-none focus:border-[#0965EE] focus:bg-white"
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
  );
}
