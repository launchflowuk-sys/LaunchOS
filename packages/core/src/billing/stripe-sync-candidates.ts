import type { PaymentsSubscriptionDetail } from "@launchos/integrations";

/**
 * "File under" suggestions for a Stripe customer the sync cannot match
 * outright: clients that share the customer's email domain, or whose name
 * shares a distinctive word with the Stripe name. Pure — scored from an
 * in-memory snapshot of the organisation's clients, no reads.
 */

export interface StripeSyncCandidate {
  clientId: string;
  name: string;
  /** Human-readable, for the review screen: "Same email domain (grays-taxis.co.uk)". */
  reason: string;
}

/** Everything about a client that a candidate can be scored on. */
export interface CandidateSource {
  clientId: string;
  name: string;
  tradingName: string | null;
  /** Client email, contacts' emails and portal users' emails, normalised. */
  emails: readonly string[];
}

/** Mailbox providers whose domain says nothing about which business a customer is. */
const SHARED_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.co.uk", "outlook.com", "outlook.co.uk", "live.com", "live.co.uk",
  "yahoo.com", "yahoo.co.uk", "icloud.com", "me.com", "aol.com", "btinternet.com", "sky.com", "protonmail.com", "proton.me",
  "mail.com", "msn.com", "ymail.com",
]);

/** Words that every business name carries and so tell two apart from nobody. */
const NAME_NOISE: ReadonlySet<string> = new Set([
  "ltd", "limited", "llp", "plc", "cic", "co", "company", "the", "and", "of", "uk", "group", "services", "service",
  "solutions", "trading", "inc", "corp",
]);

const MAX_CANDIDATES = 5;

export function emailDomain(email: string | null | undefined): string | null {
  const parts = (email ?? "").trim().toLowerCase().split("@");
  const domain = parts.length === 2 ? parts[1] : undefined;
  return domain && domain.includes(".") && !SHARED_MAIL_DOMAINS.has(domain) ? domain : null;
}

/** "Grays Town Taxis Ltd" → {"grays", "town", "taxis"}. */
export function nameTokens(name: string | null | undefined): Set<string> {
  const tokens = (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !NAME_NOISE.has(word));
  return new Set(tokens);
}

interface Scored extends StripeSyncCandidate {
  score: number;
}

function scoreClient(
  source: CandidateSource,
  customerDomain: string | null,
  customerTokens: ReadonlySet<string>,
): Scored | null {
  const domains = new Set(source.emails.map((e) => emailDomain(e)).filter((d): d is string => d !== null));
  if (customerDomain && domains.has(customerDomain)) {
    return { clientId: source.clientId, name: source.name, reason: `Same email domain (${customerDomain})`, score: 100 };
  }
  const own = new Set([...nameTokens(source.name), ...nameTokens(source.tradingName)]);
  const shared = [...customerTokens].filter((token) => own.has(token));
  if (shared.length === 0) return null;
  const coverage = shared.length / Math.max(customerTokens.size, own.size);
  return {
    clientId: source.clientId,
    name: source.name,
    reason: `Name shares "${shared.join(" ")}"`,
    score: Math.round(coverage * 60) + shared.length,
  };
}

/**
 * The clients a Stripe customer could plausibly be, best first, at most five,
 * never the one already matched. A shared (non-webmail) email domain ranks
 * above a shared name word; the more of the name that overlaps, the higher.
 */
export function candidatesFor(
  detail: Pick<PaymentsSubscriptionDetail, "customerEmail" | "customerName">,
  sources: readonly CandidateSource[],
  excludeClientId: string | null,
): StripeSyncCandidate[] {
  const customerDomain = emailDomain(detail.customerEmail);
  const customerTokens = nameTokens(detail.customerName);
  if (!customerDomain && customerTokens.size === 0) return [];
  return sources
    .filter((source) => source.clientId !== excludeClientId)
    .map((source) => scoreClient(source, customerDomain, customerTokens))
    .filter((scored): scored is Scored => scored !== null)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_CANDIDATES)
    .map(({ clientId, name, reason }) => ({ clientId, name, reason }));
}
