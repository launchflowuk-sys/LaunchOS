import type { DomainAvailability, RegistrarAdapter, RegistrarDomain, SupplierSubscription } from "./types.js";

/**
 * Knows nothing, and says so.
 *
 * Empty lists rather than invented data on purpose: the sync writes renewal
 * dates and costs onto real records, and a mock that guessed would fill the
 * books with fiction that then drives warnings and margin figures. "The
 * supplier told us nothing" and "the supplier says it costs $38" must never be
 * confusable, so the mock only ever produces the first.
 */
export class MockRegistrarAdapter implements RegistrarAdapter {
  readonly name = "mock" as const;

  constructor(
    private readonly domains: readonly RegistrarDomain[] = [],
    private readonly subscriptions: readonly SupplierSubscription[] = [],
  ) {}

  async listDomains(): Promise<RegistrarDomain[]> {
    return [...this.domains];
  }

  async listSubscriptions(): Promise<SupplierSubscription[]> {
    return [...this.subscriptions];
  }

  /** Unavailable, never free: a mock that says "yes, buy it" is the dangerous answer. */
  async checkAvailability(name: string): Promise<DomainAvailability> {
    return { name: name.trim().toLowerCase(), available: false, price: null, currencyCode: null, premium: false };
  }
}
