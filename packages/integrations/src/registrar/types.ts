/**
 * What a registrar can tell us about a domain we manage.
 *
 * Deliberately tiny. LaunchOS does not buy, transfer or renew domains through
 * an API — it *watches* them, because a domain that lapses takes the client's
 * website and their email with it and no monitor sees it coming. So the only
 * question this interface answers is the one that matters: when does it run
 * out, and is it set to renew itself.
 */

export interface RegistrarDomain {
  /** Apex name, lower-cased, no trailing dot — matched against `domains.name`. */
  name: string;
  /** When it lapses. Null when the registrar does not say. */
  expiresAt: Date | null;
  /**
   * When it was registered. Carried because it is what ties a domain to the
   * anonymous `.CO.UK Domain` line on the bill: the two are created seconds
   * apart, and the product name never names the domain.
   */
  registeredAt: Date | null;
  /** Null when the registrar does not report it, which is not the same as false. */
  autoRenew: boolean | null;
  /** The registrar's own word for the state, kept verbatim for the audit row. */
  status: string | null;
}

export interface RegistrarAdapter {
  readonly name: "hostinger" | "mock";
  /** Every domain on the account. Throws on auth or transport failure; never returns a partial list silently. */
  listDomains(): Promise<RegistrarDomain[]>;
  /** Every subscription LaunchFlow pays for — the cost side of the ledger. */
  listSubscriptions(): Promise<SupplierSubscription[]>;
  /** Whether a name can be bought, and for how much. */
  checkAvailability(name: string): Promise<DomainAvailability>;
}

/**
 * One subscription on the supplier's account — what LaunchFlow itself pays.
 *
 * Amounts stay in the supplier's own currency and minor unit. Converting on
 * the way in would store a figure that cannot be re-read when the rate moves
 * and cannot be checked against their invoice.
 */
export interface SupplierSubscription {
  /** Their id, stable across syncs. */
  id: string;
  /** Their product name — ".LIVE Domain", "Starter Business Email". Never a domain name. */
  name: string;
  status: string;
  /** Minor units, e.g. USD cents. */
  renewalPrice: number;
  totalPrice: number;
  currencyCode: string;
  billingPeriod: number;
  billingPeriodUnit: string;
  autoRenewed: boolean;
  nextBillingAt: Date | null;
  /**
   * When the supplier started it — which is the only field that says *what it
   * is for*. The product name never does: a `.CO.UK Domain` line is named
   * after the product, not the domain. But a domain and its subscription are
   * created in the same transaction, seconds apart, so this matches the two
   * exactly. On this account it resolves 27 of 27 domain subscriptions with
   * nothing ambiguous.
   */
  startedAt: Date | null;
}

/** What a name would cost, and whether it can be had at all. */
export interface DomainAvailability {
  name: string;
  available: boolean;
  /** Minor units in `currencyCode`, or null when the supplier did not price it. */
  price: number | null;
  currencyCode: string | null;
  /** True when the supplier says it is a premium name, which is priced separately. */
  premium: boolean;
}
