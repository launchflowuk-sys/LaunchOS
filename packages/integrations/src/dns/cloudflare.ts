import type { DnsProvider, DnsRecordChange, DnsRecordRemoval, DnsRecordResult } from "../cloudflare/index.js";
import { DnsApiError, DnsHttpClient, errorMessageFrom, type DnsHttpOptions } from "./http.js";
import { fullyQualifiedName } from "./names.js";

/**
 * Cloudflare API v4. Records have ids, so an update is a real update: find the
 * zone by name, find the record by type + fully qualified name, then PUT the
 * existing one or POST a new one.
 *
 * Every response is an envelope — `{ success, errors, result }` — and a 200
 * with `success: false` is a failure, so the envelope is checked as well as the
 * status code. `applied` follows the returned record id and nothing else.
 */

const DEFAULT_BASE_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_TTL_SECONDS = 300;
/** Only these types accept `proxied`; sending it on a TXT record is an error. */
const PROXYABLE = new Set(["A", "AAAA", "CNAME"]);

interface CloudflareEnvelope<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

interface CloudflareZone {
  id: string;
  name: string;
}

interface CloudflareRecord {
  id: string;
  type?: string;
  name?: string;
  content?: string;
}

export class CloudflareDnsProvider implements DnsProvider {
  readonly name = "cloudflare" as const;

  private readonly http: DnsHttpClient;
  private readonly baseUrl: string;
  /** Zone ids do not change; one lookup per zone per process is enough. */
  private readonly zoneIds = new Map<string, string>();

  constructor(options: DnsHttpOptions) {
    this.http = new DnsHttpClient("cloudflare", options);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async updateRecord(input: DnsRecordChange): Promise<DnsRecordResult> {
    const zoneId = await this.zoneId(input.zone);
    const name = fullyQualifiedName(input.name, input.zone);
    const existing = await this.findRecord(zoneId, input.type, name);

    const payload = {
      type: input.type,
      name,
      content: input.value,
      ttl: input.ttl ?? DEFAULT_TTL_SECONDS,
      ...(input.proxied !== undefined && PROXYABLE.has(input.type) ? { proxied: input.proxied } : {}),
    };
    const response = existing
      ? await this.http.send<CloudflareEnvelope<CloudflareRecord>>(
          "PUT",
          `${this.baseUrl}/zones/${zoneId}/dns_records/${existing.id}`,
          payload,
        )
      : await this.http.send<CloudflareEnvelope<CloudflareRecord>>(
          "POST",
          `${this.baseUrl}/zones/${zoneId}/dns_records`,
          payload,
        );

    const record = this.confirmed(response.body, response.status, `writing ${input.type} ${name}`);
    return { recordId: record.id, applied: true, zone: input.zone };
  }

  async deleteRecord(input: DnsRecordRemoval): Promise<DnsRecordResult> {
    const zoneId = await this.zoneId(input.zone);
    const name = fullyQualifiedName(input.name, input.zone);
    const existing = await this.findRecord(zoneId, input.type, name);
    if (!existing) {
      throw new DnsApiError("cloudflare", "record_not_found", `no ${input.type} record named ${name}`, 404);
    }

    const response = await this.http.send<CloudflareEnvelope<CloudflareRecord>>(
      "DELETE",
      `${this.baseUrl}/zones/${zoneId}/dns_records/${existing.id}`,
    );
    const record = this.confirmed(response.body, response.status, `deleting ${input.type} ${name}`);
    return { recordId: record.id, applied: true, zone: input.zone };
  }

  private async zoneId(zone: string): Promise<string> {
    const cached = this.zoneIds.get(zone);
    if (cached) return cached;

    const response = await this.http.send<CloudflareEnvelope<CloudflareZone[]>>(
      "GET",
      `${this.baseUrl}/zones?name=${encodeURIComponent(zone)}`,
    );
    const id = response.body?.result?.[0]?.id;
    if (!id) {
      throw new DnsApiError(
        "cloudflare",
        "zone_not_found",
        `no zone named ${zone} on this account${suffix(response.body)}`,
        response.status,
      );
    }
    this.zoneIds.set(zone, id);
    return id;
  }

  private async findRecord(zoneId: string, type: string, name: string): Promise<CloudflareRecord | null> {
    const query = `type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`;
    const response = await this.http.send<CloudflareEnvelope<CloudflareRecord[]>>(
      "GET",
      `${this.baseUrl}/zones/${zoneId}/dns_records?${query}`,
    );
    return response.body?.result?.[0] ?? null;
  }

  /** A record id, or a throw. Nothing else may be read as "the change landed". */
  private confirmed(body: CloudflareEnvelope<CloudflareRecord> | null, status: number, what: string): CloudflareRecord {
    const record = body?.result;
    if (body?.success === false || !record?.id) {
      throw new DnsApiError("cloudflare", "http", `${what} was not confirmed${suffix(body)}`, status);
    }
    return record;
  }
}

function suffix(body: unknown): string {
  const message = errorMessageFrom(body);
  return message ? `: ${message}` : "";
}
