/**
 * The DNS contract every provider implements, and the mocks that stand in for
 * them. The real HTTP clients live in `../dns/` — this file stays free of
 * network code so the interface can be imported from anywhere without dragging
 * a provider along.
 */

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT";

/**
 * `domains.dns_provider` — the column that says who answers for a zone. Kept in
 * step with `dnsProviderEnum` in `packages/db/src/schema/sites.ts`; adding a
 * value there means adding it here and giving `DnsProviderRegistry` something
 * to route it to.
 */
export type DomainDnsProvider = "cloudflare" | "hostinger" | "registrar" | "other";

export interface DnsRecordChange {
  zone: string;
  type: DnsRecordType;
  name: string;
  value: string;
  ttl?: number;
  proxied?: boolean;
  /**
   * The zone's `domains.dns_provider`. A registry routes on it; a single
   * provider ignores it. Optional so every existing caller still compiles —
   * an unset value routes to the registry's fallback, which is a mock, so a
   * caller that forgets it cannot accidentally touch a live zone.
   */
  provider?: DomainDnsProvider;
}

/** A record set to remove, addressed the way both APIs address one: name + type. */
export interface DnsRecordRemoval {
  zone: string;
  type: DnsRecordType;
  name: string;
  provider?: DomainDnsProvider;
}

export interface DnsRecordResult {
  recordId: string;
  /** True only when the provider confirmed the write. Never optimistic. */
  applied: boolean;
  zone: string;
}

export type DnsProviderName =
  | "mock-dns"
  | "mock-cloudflare"
  | "mock-hostinger"
  | "cloudflare"
  | "hostinger"
  | "dns-registry";

export interface DnsProvider {
  readonly name: DnsProviderName;
  updateRecord(input: DnsRecordChange): Promise<DnsRecordResult>;
  /** Optional: not every provider needs removal wired before it is useful. */
  deleteRecord?(input: DnsRecordRemoval): Promise<DnsRecordResult>;
  /**
   * Which provider actually answers for a domain on this `dns_provider`.
   * A registry resolves; a single provider does not implement it, and callers
   * fall back to the provider itself (`dns.for?.(key) ?? dns`).
   *
   * It exists so the approval card can name the adapter that will really run —
   * a registry called `dns-registry` says nothing about whether the zone about
   * to be touched is live or mocked.
   */
  for?(provider: DomainDnsProvider | string | null | undefined): DnsProvider;
}

/**
 * Records what it was asked to change and reports success, touching nothing.
 * The approval card keys off the `mock-` prefix to tell the approver that no
 * zone will be written.
 */
export class MockDnsProvider implements DnsProvider {
  readonly changes: DnsRecordChange[] = [];
  readonly removals: DnsRecordRemoval[] = [];

  constructor(readonly name: DnsProviderName = "mock-dns") {}

  async updateRecord(input: DnsRecordChange): Promise<DnsRecordResult> {
    this.changes.push(input);
    return { recordId: `mock-dns-${this.changes.length}`, applied: true, zone: input.zone };
  }

  async deleteRecord(input: DnsRecordRemoval): Promise<DnsRecordResult> {
    this.removals.push(input);
    return { recordId: `mock-dns-removed-${this.removals.length}`, applied: true, zone: input.zone };
  }
}

/** The mock that stands in for Cloudflare when `CLOUDFLARE_API_TOKEN` is unset. */
export class MockCloudflareDns extends MockDnsProvider {
  constructor() {
    super("mock-cloudflare");
  }
}

/** The mock that stands in for Hostinger when `HOSTINGER_API_TOKEN` is unset. */
export class MockHostingerDns extends MockDnsProvider {
  constructor() {
    super("mock-hostinger");
  }
}
