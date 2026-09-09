"use client";

import { Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Result =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "answer"; name: string; available: boolean; price: number | null; currencyCode: string | null; premium: boolean }
  | { kind: "error"; message: string };

/**
 * "Can I promise them that name?"
 *
 * Answering it used to mean leaving LaunchOS for a registrar's search box in
 * the middle of writing a proposal. The price shown is what *we* would pay —
 * it is on an admin screen for that reason, and is a cost to quote from, not a
 * price to repeat.
 */
export function AvailabilityCheck() {
  const [name, setName] = useState("");
  const [result, setResult] = useState<Result>({ kind: "idle" });

  async function check() {
    const wanted = name.trim().toLowerCase();
    if (!wanted.includes(".")) {
      setResult({ kind: "error", message: "Include the ending, like .co.uk" });
      return;
    }
    setResult({ kind: "checking" });
    try {
      const response = await fetch(`/api/domains/availability?name=${encodeURIComponent(wanted)}`);
      const body = await response.json();
      if (!response.ok) {
        setResult({ kind: "error", message: body.error ?? "That could not be checked." });
        return;
      }
      setResult({ kind: "answer", ...body });
    } catch {
      setResult({ kind: "error", message: "That could not be checked." });
    }
  }

  return (
    <div className="rounded-[20px] border bg-card p-5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-52 flex-1 space-y-1.5">
          <label htmlFor="domain-availability" className="text-sm font-medium">Is a domain free?</label>
          <Input
            id="domain-availability"
            value={name}
            placeholder="theirbusiness.co.uk"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void check(); }}
          />
        </div>
        <Button type="button" variant="secondary" size="lg" onClick={() => void check()} loading={result.kind === "checking"}>
          <Search aria-hidden strokeWidth={1.9} className="size-4" />
          Check
        </Button>
      </div>

      {result.kind === "answer" ? (
        <p
          className={cn(
            "mt-4 rounded-[14px] px-3.5 py-3 text-sm",
            result.available ? "bg-success-bg text-success-fg" : "bg-muted text-muted-foreground",
          )}
        >
          <span className="font-semibold">{result.name}</span>{" "}
          {result.available ? "is available" : "is already taken"}
          {result.available && result.price !== null
            ? ` — costs us ${result.currencyCode === "USD" ? "$" : ""}${(result.price / 100).toFixed(2)}${
              result.currencyCode && result.currencyCode !== "USD" ? ` ${result.currencyCode}` : ""
            } a year`
            : ""}
          {result.premium ? " (a premium name, priced separately)" : ""}
        </p>
      ) : null}

      {result.kind === "error" ? (
        <p className="mt-4 rounded-[14px] bg-danger-bg px-3.5 py-3 text-sm text-danger-fg">{result.message}</p>
      ) : null}
    </div>
  );
}
