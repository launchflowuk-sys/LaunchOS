import { formatDate } from "@/lib/format";

/**
 * "1 Aug 2026 — 31 Aug 2026" reads better to a client than two ISO dates.
 *
 * It lives beside the pages rather than inside them because a `page.tsx` may
 * only export the handful of names Next.js knows about.
 */
export function periodLabel(start: string, end: string): string {
  return `${formatDate(start)} — ${formatDate(end)}`;
}
