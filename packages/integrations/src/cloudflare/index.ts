export interface DnsRecordChange {
  zone: string;
  type: "A" | "AAAA" | "CNAME" | "MX" | "TXT";
  name: string;
  value: string;
  ttl?: number;
  proxied?: boolean;
}
export interface DnsRecordResult { recordId: string; applied: boolean; zone: string }

export interface DnsProvider {
  readonly name: "mock-cloudflare" | "cloudflare";
  updateRecord(input: DnsRecordChange): Promise<DnsRecordResult>;
}

/**
 * Records what it was asked to change and reports success. The real Cloudflare
 * client needs CLOUDFLARE_API_TOKEN and is a reported external blocker.
 */
export class MockCloudflareDns implements DnsProvider {
  readonly name = "mock-cloudflare" as const;
  readonly changes: DnsRecordChange[] = [];

  async updateRecord(input: DnsRecordChange): Promise<DnsRecordResult> {
    this.changes.push(input);
    return { recordId: `mock-dns-${this.changes.length}`, applied: true, zone: input.zone };
  }
}
