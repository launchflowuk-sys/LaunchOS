import type { ClientReportStats } from "@launchos/db/schema";

/**
 * Whether a month's report has anything in it worth sending.
 *
 * Why this exists. The monthly sweep compiled, rendered and queued an approval
 * card for every active client on the 1st, with no check on whether the month
 * contained anything. For a client with no content switched on, no ads, no
 * cases and no incidents that is a PDF of zeroes and a card asking the owner to
 * send it — thirteen of which piled up in the queue, each one a decision about
 * nothing. The cost is not the wasted render; it is that a queue full of empty
 * cards is a queue nobody reads, which is where the real ones get lost.
 *
 * So the sweep asks this first and, when the answer is no, leaves the report a
 * draft and asks nobody. The record is still written, so a month that was
 * considered and found empty is distinguishable from one that never ran, and a
 * re-run after the data arrives picks it up and asks then.
 *
 * Every figure is treated the same way: a count above zero is something that
 * happened, and zero is not. The two judgment calls are documented below,
 * because they are the only places where a reasonable person might draw the
 * line elsewhere.
 */

/**
 * Below this, a month's uptime is worth telling a client about.
 *
 * The judgment call. A flawless month on a site where nothing else happened is
 * the monitoring dashboard rather than an account report, so 100% on its own
 * does not earn a document — whereas any dip does, because that is precisely
 * the thing a client wants to have been told about before they notice it
 * themselves. Named so that moving the line is one number, not a rewrite.
 */
export const UPTIME_SUBSTANCE_BELOW = 100;

/** True when at least one thing happened this month that a client would want reported. */
export function reportHasSubstance(stats: Partial<ClientReportStats>): boolean {
  // Work delivered. `tasksOpen` is deliberately not here: things we have not
  // finished are work in progress, and a document whose only content is a list
  // of them is not one anybody would choose to send.
  if ((stats.tasksDone ?? 0) > 0) return true;

  if ((stats.ticketsOpened ?? 0) > 0 || (stats.ticketsResolved ?? 0) > 0) return true;

  const incidents = stats.incidents;
  if (incidents && (incidents.opened > 0 || incidents.resolved > 0 || incidents.openAtPeriodEnd > 0)) return true;

  // Published, not planned: "we planned four posts and published none" is a
  // report about us, and every client sits in that state before the writer runs.
  if ((stats.content?.published ?? 0) > 0) return true;

  if ((stats.satisfaction?.responses ?? 0) > 0) return true;

  const payments = stats.payments;
  if (payments && (payments.received > 0 || payments.receivedPence > 0)) return true;

  const invoices = stats.invoices;
  if (invoices && (invoices.issued > 0 || invoices.paidPence > 0 || invoices.outstandingPence > 0)) return true;

  // An ad account whose figures are all zero is one with a paused campaign. The
  // row existing is not the same as the campaign having run.
  const ads = stats.ads;
  if (ads && (ads.spendPence > 0 || ads.clicks > 0 || ads.conversions > 0)) return true;

  const uptime = stats.uptimePercent;
  if (uptime !== null && uptime !== undefined && uptime < UPTIME_SUBSTANCE_BELOW) return true;

  return false;
}
