"use client";

import { useEffect, useState } from "react";

const MINUTE_MS = 60_000;

/**
 * Whole minutes since `startedAt`, ticking once a minute.
 *
 * The first value is the one the server computed, so the number in the HTML
 * and the number React hydrates are the same; the interval only takes over
 * after mount, and the figure never goes backwards. A null `startedAt` means
 * nothing is running and the value stays put.
 */
export function useRunningMinutes(startedAt: string | null, initialMinutes: number): number {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(id);
  }, [startedAt]);

  if (!startedAt || now === null) return initialMinutes;
  const elapsed = Math.floor((now - new Date(startedAt).getTime()) / MINUTE_MS);
  return Math.max(initialMinutes, elapsed);
}
