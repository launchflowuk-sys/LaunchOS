/**
 * When a client's monthly report should reach them.
 *
 * It used to go out at 07:45 on the 1st, to everybody at once. That is a
 * sensible default and it misses the point of the document: the report exists
 * so that at the moment a client decides the money is worth it, they have just
 * read what they got. On the 1st, a client who pays on the 20th reads it three
 * weeks early and has forgotten it by the time the invoice lands.
 *
 * So it is timed to **their** payment date, a few days ahead of it.
 *
 * The complication is that a report is about a finished month. Five days before
 * a payment on the 5th is the 31st, and on the 31st the month that has finished
 * is the one *before* the current one — so a naive "five days early" reports
 * July to somebody about to pay for September. The send therefore waits for
 * whichever comes later: the end of the month being reported, or the lead-up to
 * payment. In practice a client paying on the 5th gets August's report on
 * 1 September, four days before they pay, which is the intent.
 */

/** Five days: long enough to be read before the money moves, close enough to still be in mind. */
export const REPORT_LEAD_DAYS = 5;

const DAY_MS = 86_400_000;

export interface ReportTimingInput {
  /** The day the money is expected — `subscriptions.current_period_start`. */
  paymentDate: Date;
  /** How far ahead of payment the report should land. */
  leadDays?: number | undefined;
}

export interface ReportTiming {
  /** The first moment the report may be built and sent. */
  sendFrom: Date;
  /** The calendar month the report covers: the one that ended before payment. */
  periodStart: Date;
  periodEnd: Date;
}

/** The UTC start of the calendar month containing `at`. */
function monthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export function reportTimingFor(input: ReportTimingInput): ReportTiming {
  const lead = Math.max(0, Math.min(Math.trunc(input.leadDays ?? REPORT_LEAD_DAYS), 28));

  // The month that has finished by the time they pay. A payment on 5 September
  // is preceded by August; a payment on 1 September is preceded by August too,
  // because August ended the day before.
  const periodEnd = monthStart(input.paymentDate);
  const periodStart = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() - 1, 1));

  // Whichever is later. Before `periodEnd` the month is not finished and the
  // figures would be partial; before `paymentDate - lead` it is simply early.
  const leadMoment = new Date(input.paymentDate.getTime() - lead * DAY_MS);
  const sendFrom = leadMoment.getTime() > periodEnd.getTime() ? leadMoment : periodEnd;

  return { sendFrom, periodStart, periodEnd };
}

/**
 * Whether this client's report is due.
 *
 * "On or after" rather than "on", so a worker that was down for a day catches
 * up instead of skipping somebody's month entirely — the same reasoning as the
 * invoice sweep. Sending late is a small failure; not sending is the one that
 * costs a client.
 */
export function isReportDue(timing: ReportTiming, now: Date): boolean {
  return now.getTime() >= timing.sendFrom.getTime();
}
