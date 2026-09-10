"use client";

import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useState } from "react";

/**
 * "Carry on" — the only thing that spends a resume token.
 *
 * The token is read from the URL and posted, never followed. After a successful
 * exchange the browser is sent to a clean address, so the token does not sit in
 * history, in a bookmark, or in the referrer of the next request.
 *
 * Every refusal reads the same, because unknown, spent, revoked and expired
 * must be indistinguishable from out here.
 */
export function ResumePanel() {
  const params = useSearchParams();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const token = params.get("token") ?? "";

  const carryOn = async () => {
    setBusy(true);
    setFailed(false);
    const response = await fetch("/api/brief-funnel/resume", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      setFailed(true);
      setBusy(false);
      return;
    }
    // `replace`, not `push`: the token must not be one Back button away.
    router.replace("/start");
  };

  return (
    <div className="w-full max-w-[480px] rounded-[24px] border border-[#DFE4EB] bg-white p-8 text-center shadow-[0_1px_2px_rgba(16,24,40,.04),0_18px_44px_-28px_rgba(16,24,40,.22)]">
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.9px] text-[#111827]">
        {failed ? "That link has expired" : "Welcome back"}
      </h1>

      {failed ? (
        <>
          <p className="mt-3 text-[15.5px] leading-relaxed text-[#626D80]">
            Resume links work once and last 48 hours. Nothing has been lost — start again and we will find
            your answers, or ask us for a new link.
          </p>
          <Link
            href="/start"
            className="mt-6 inline-flex min-h-[51px] items-center justify-center rounded-[12px] bg-[#0965EE] px-6 text-[15.5px] font-semibold text-white transition hover:bg-[#0457D3]"
          >
            Go to the brief
          </Link>
        </>
      ) : (
        <>
          <p className="mt-3 text-[15.5px] leading-relaxed text-[#626D80]">
            Your website brief is where you left it. Everything you entered is still saved.
          </p>
          <button
            type="button"
            onClick={() => void carryOn()}
            disabled={busy || !token}
            className="mt-6 inline-flex min-h-[51px] w-full items-center justify-center gap-2 rounded-[12px] bg-[#0965EE] px-6 text-[15.5px] font-semibold text-white transition hover:bg-[#0457D3] disabled:opacity-60"
          >
            {busy ? <Loader2 aria-hidden className="size-4 animate-spin" /> : null}
            Carry on with my brief
          </button>
          {!token ? (
            <p className="mt-3 text-[13.5px] text-[#B43A34]">That link is missing its code.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
