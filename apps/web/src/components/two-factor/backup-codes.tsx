"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";

/**
 * The one and only showing of a set of backup codes.
 *
 * They are credentials: each one signs somebody in on its own, past the
 * authenticator. The server keeps them encrypted and hands them back exactly
 * once — at enrolment, or when a set is replaced — so this component says so
 * in the strongest terms the page has, and the only way past it is the button
 * that admits they have been written down.
 *
 * Nothing here logs, and nothing persists them: no localStorage, no analytics,
 * no `console`. The clipboard copy is the person's own doing.
 */
export function BackupCodes({ codes, onDone }: { codes: readonly string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // A browser that refuses the clipboard is not a failure worth a banner:
      // the codes are on the screen and can be typed out.
      setCopied(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="backup-codes">
      <InlineAlert tone="warning" title="Save these now — they will not be shown again">
        Each code signs you in once, without your phone. Keep them somewhere you can reach without this account: a
        password manager, or printed and put away. If you lose both your authenticator and these codes, only Shoji can
        get you back in.
      </InlineAlert>

      <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-xl border bg-background p-4 font-mono text-sm tabular-nums sm:grid-cols-2">
        {codes.map((code) => (
          <li key={code} className="tracking-wide">
            {code}
          </li>
        ))}
      </ul>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="button" variant="secondary" onClick={copy}>
          {copied ? <Check aria-hidden strokeWidth={1.75} /> : <Copy aria-hidden strokeWidth={1.75} />}
          {copied ? "Copied" : "Copy codes"}
        </Button>
        <Button type="button" disabled={!saved} onClick={onDone}>
          Done
        </Button>
      </div>

      <label className="flex items-start gap-2 text-sm text-muted-foreground">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          className="mt-0.5 size-4 rounded border-input accent-primary"
        />
        I have saved these codes somewhere safe.
      </label>
    </div>
  );
}
