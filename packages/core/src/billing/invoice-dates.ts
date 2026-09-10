/**
 * When an invoice is issued, and when the money is expected.
 *
 * These are two different dates and the product had them fused: `dueAt` was
 * `issuedAt + paymentTermsDays`, with `issuedAt` defaulting to the day the
 * period started. That describes a business billing **in arrears** — do the
 * work, invoice, wait thirty days.
 *
 * LaunchFlow does not run that way for anybody paying by transfer. The money is
 * expected **on** the period start, and the invoice is notice sent beforehand.
 * Same two numbers, opposite direction — which is why an invoice raised on
 * 5 September came out due 5 October when the client had last paid on 4 August
 * and was a month behind by anyone's reckoning.
 *
 * So:
 *
 * - **In advance** (bank transfer, standing order, cash — anything a person
 *   has to act on): due on the period start, issued `noticeDays` before it.
 *   Seven days' notice on a period starting the 5th means sending on the 29th.
 * - **Stripe**: untouched. It collects on its own schedule and reconciles
 *   itself; an invoice raised here is a record of something that already
 *   happened, so it is issued and due the same day it is raised.
 *
 * Pure, and separate from the row-writing, because this is the rule that was
 * wrong and a rule that decides when a client is chased for money should be
 * readable on its own.
 */

/** How the money arrives — `subscriptions.collection_method`. */
export type BillingDirection = "advance" | "arrears";

/**
 * Stripe reconciles itself, so its invoices are records rather than demands.
 * Everything else needs a person to act, and a person needs warning.
 */
export function directionFor(collectionMethod: string): BillingDirection {
  return collectionMethod === "stripe" ? "arrears" : "advance";
}

/** A week. Long enough to reach a client who checks email on Mondays. */
export const NOTICE_DEFAULT_DAYS = 7;

const DAY_MS = 86_400_000;

export interface InvoiceDatesInput {
  /** The period being billed for. In advance, this is the day the money is due. */
  periodStart: Date;
  collectionMethod: string;
  /** Days of warning before the money is due. Only used in advance. */
  noticeDays?: number | undefined;
  /** Arrears only: the day the invoice is being raised. */
  now?: Date | undefined;
}

export interface InvoiceDates {
  issuedAt: Date;
  dueAt: Date;
  direction: BillingDirection;
}

export function invoiceDatesFor(input: InvoiceDatesInput): InvoiceDates {
  const direction = directionFor(input.collectionMethod);

  if (direction === "arrears") {
    // Stripe has already taken it, or is about to on its own schedule. The
    // record is dated the day it is written.
    const at = input.now ?? input.periodStart;
    return { issuedAt: at, dueAt: at, direction };
  }

  // A negative or absurd notice would post-date an invoice past the money it is
  // asking for, so it is clamped rather than trusted: a bad settings value must
  // not silently move a due date.
  const notice = Math.max(0, Math.min(Math.trunc(input.noticeDays ?? NOTICE_DEFAULT_DAYS), 90));
  return {
    issuedAt: new Date(input.periodStart.getTime() - notice * DAY_MS),
    dueAt: input.periodStart,
    direction,
  };
}

/**
 * Whether an invoice for this period should have gone out by now.
 *
 * The sweep's question. It is "on or before" rather than "on", so a job that
 * did not run on the day — a restart, a bad deploy, a weekend of downtime —
 * catches up rather than skipping a client's month in silence.
 */
export function isDueToRaise(dates: InvoiceDates, now: Date): boolean {
  return dates.issuedAt.getTime() <= now.getTime();
}
