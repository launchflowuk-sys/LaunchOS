import type { DnsProvider, DnsRecordChange, DnsRecordRemoval, DnsRecordResult } from "../cloudflare/index.js";
import { DnsApiError, DnsHttpClient, type DnsHttpOptions } from "./http.js";
import { relativeName } from "./names.js";

/**
 * Hostinger's DNS API works on **record sets**, not records: one entry per
 * name + type, holding a list of contents. There are no record ids, so a change
 * is addressed by `name` and `type` and the id we hand back is synthesised from
 * them — stable across calls, which is what the audit row and the approval card
 * actually need.
 *
 * Endpoints (all under `/api/dns/v1/zones/{domain}`):
 *   GET     — the whole zone, as an array of record sets. 404 when the domain
 *             is not on this account, which is how zone-not-found is detected.
 *   PUT     — `{ overwrite: false, zone: [...] }`. `overwrite: false` limits
 *             the write to the record sets named in `zone`; the rest of the
 *             zone is left alone. A set that does not exist is created, one
 *             that does is replaced — the upsert we want.
 *   DELETE  — `{ filters: [{ name, type }] }`.
 */

const DEFAULT_BASE_URL = "https://developers.hostinger.com/api/dns/v1";
const DEFAULT_TTL_SECONDS = 300;

interface HostingerRecordSet {
  name: string;
  type: string;
  ttl?: number;
  records?: { content: string }[];
}

export class HostingerDnsProvider implements DnsProvider {
  readonly name = "hostinger" as const;

  private readonly http: DnsHttpClient;
  private readonly baseUrl: string;

  constructor(options: DnsHttpOptions) {
    this.http = new DnsHttpClient("hostinger", options);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async updateRecord(input: DnsRecordChange): Promise<DnsRecordResult> {
    const name = relativeName(input.name, input.zone);
    // The GET is not decoration: it is the only way to tell "this domain is not
    // on the account" from "this record does not exist yet", and it carries the
    // TTL to keep when the caller did not name one.
    const existing = await this.recordSet(input.zone, name, input.type);
    const ttl = input.ttl ?? existing?.ttl ?? DEFAULT_TTL_SECONDS;

    const response = await this.http.send<unknown>("PUT", this.zoneUrl(input.zone), {
      overwrite: false,
      zone: [{ name, type: input.type, ttl, records: [{ content: input.value }] }],
    });
    if (response.status === 404) throw this.zoneNotFound(input.zone);

    return { recordId: recordSetId(input.zone, input.type, name), applied: true, zone: input.zone };
  }

  async deleteRecord(input: DnsRecordRemoval): Promise<DnsRecordResult> {
    const name = relativeName(input.name, input.zone);
    const existing = await this.recordSet(input.zone, name, input.type);
    if (!existing) {
      throw new DnsApiError(
        "hostinger",
        "record_not_found",
        `no ${input.type} record set named ${name} exists on ${input.zone}`,
        404,
      );
    }

    const response = await this.http.send<unknown>("DELETE", this.zoneUrl(input.zone), {
      filters: [{ name, type: input.type }],
    });
    if (response.status === 404) throw this.zoneNotFound(input.zone);

    return { recordId: recordSetId(input.zone, input.type, name), applied: true, zone: input.zone };
  }

  /** The current set for this name + type, or null when the zone has none. */
  private async recordSet(zone: string, name: string, type: string): Promise<HostingerRecordSet | null> {
    const response = await this.http.send<HostingerRecordSet[]>("GET", this.zoneUrl(zone));
    if (response.status === 404) throw this.zoneNotFound(zone);
    if (!Array.isArray(response.body)) {
      throw new DnsApiError("hostinger", "malformed", `the zone listing for ${zone} was not an array`, response.status);
    }
    return (
      response.body.find((set) => set.type === type && relativeName(set.name, zone) === name) ?? null
    );
  }

  private zoneUrl(zone: string): string {
    return `${this.baseUrl}/zones/${encodeURIComponent(zone)}`;
  }

  private zoneNotFound(zone: string): DnsApiError {
    return new DnsApiError("hostinger", "zone_not_found", `no DNS zone for ${zone} on this account`, 404);
  }
}

/** Hostinger has no record ids, so the addressable set is the identity. */
function recordSetId(zone: string, type: string, name: string): string {
  return `hostinger:${zone}:${type}:${name}`;
}
