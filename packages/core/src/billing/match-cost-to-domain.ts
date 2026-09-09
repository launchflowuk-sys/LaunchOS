/**
 * Working out which domain a line on the supplier's bill is paying for.
 *
 * The bill names products, never domains: `.CO.UK Domain`, `Starter Business
 * Email`, twenty-four times over. With seven `.co.uk` domains on the account,
 * the TLD narrows fifty-three rows to a shortlist and no further, which is why
 * assignment was being done by hand and mostly not being done at all.
 *
 * The field that does resolve it is the purchase moment. A domain and the
 * subscription that pays for it are created in the same checkout, seconds
 * apart. Renewal dates do not work — a two-year registration bills on a
 * different cycle from when it expires — but `created_at` does: on the live
 * account this resolves 27 of 27 domain subscriptions with nothing ambiguous.
 *
 * Pure, and separated from the sync, because the whole risk here is a
 * confident wrong answer attaching somebody else's cost to a client's margin.
 */

/** A domain we hold, as much of it as matching needs. */
export interface MatchableDomain {
  id: string;
  name: string;
  clientId: string;
  registeredAt: Date | null;
}

/** A line on the supplier's bill, as much of it as matching needs. */
export interface MatchableCost {
  name: string;
  startedAt: Date | null;
}

export interface CostMatch {
  domainId: string;
  clientId: string;
  /**
   * `exact` is the same checkout: a domain product whose purchase moment is
   * within a minute of the domain's. `same_day` is a companion product —
   * mailboxes bought alongside a domain — which is a good guess and not a fact.
   */
  confidence: "exact" | "same_day";
}

/** A minute. Wide enough for two writes in one checkout, far too narrow to catch a different purchase. */
const EXACT_MS = 60_000;
/** A day. For products the bill does not tie to a domain at all. */
const SAME_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `.LIVE Domain` → `live`, `Domain .cab` → `cab`. Null when it is not a domain
 * product — both spellings appear on the same account.
 */
export function tldFromProduct(name: string): string | null {
  const trimmed = name.trim();
  const suffix = /^\.([a-z0-9-]+(?:\.[a-z0-9-]+)?)\s+domain$/i.exec(trimmed);
  const prefix = /^domain\s+\.([a-z0-9-]+(?:\.[a-z0-9-]+)?)$/i.exec(trimmed);
  return (suffix?.[1] ?? prefix?.[1])?.toLowerCase() ?? null;
}

/** `graystowntaxis.co.uk` → `co.uk`. */
export function tldOfDomain(name: string): string {
  return name.split(".").slice(1).join(".").toLowerCase();
}

/**
 * The one domain this line is for, or null.
 *
 * Null whenever the answer is not certain enough to act on — no candidates, or
 * more than one equally close. Guessing between two is how a cost ends up on
 * the wrong client's margin, and a wrong attribution is worse than none because
 * nobody goes back to check a row that looks answered.
 */
export function matchCostToDomain(cost: MatchableCost, domains: readonly MatchableDomain[]): CostMatch | null {
  if (!cost.startedAt) return null;
  const started = cost.startedAt.getTime();
  const dated = domains.filter((domain) => domain.registeredAt !== null);
  if (dated.length === 0) return null;

  const tld = tldFromProduct(cost.name);

  if (tld !== null) {
    // A domain product. The TLD must agree as well as the moment: two things
    // bought in one checkout are not necessarily the same thing.
    const sameTld = dated.filter((domain) => tldOfDomain(domain.name) === tld);
    const within = sameTld.filter((domain) => Math.abs(domain.registeredAt!.getTime() - started) <= EXACT_MS);
    return within.length === 1 ? { domainId: within[0]!.id, clientId: within[0]!.clientId, confidence: "exact" } : null;
  }

  // Not a domain product — mailboxes, hosting. Nothing ties it to a domain but
  // the day it was bought, so this is offered as a suggestion and never more.
  const sameDay = dated.filter((domain) => Math.abs(domain.registeredAt!.getTime() - started) <= SAME_DAY_MS);
  return sameDay.length === 1
    ? { domainId: sameDay[0]!.id, clientId: sameDay[0]!.clientId, confidence: "same_day" }
    : null;
}
