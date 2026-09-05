import {
  MockCloudflareDns,
  MockDnsProvider,
  MockHostingerDns,
  type DnsProvider,
  type DnsRecordChange,
  type DnsRecordRemoval,
  type DnsRecordResult,
  type DomainDnsProvider,
} from "../cloudflare/index.js";
import { CloudflareDnsProvider } from "./cloudflare.js";
import { HostingerDnsProvider } from "./hostinger.js";

/**
 * One `DnsProvider` per value of `domains.dns_provider`, chosen per domain
 * rather than per deployment. LaunchFlow's zones are split across registrars —
 * some on Cloudflare, some on Hostinger, some nowhere we can reach — so a single
 * global adapter would either send Hostinger zones to Cloudflare or refuse to
 * touch anything.
 *
 * Anything the registry cannot route (`registrar`, `other`, an unset column, a
 * value added to the enum before a provider exists for it) goes to the fallback,
 * which is a mock. That is deliberate: the failure mode of a missing route is
 * "nothing happened and the approval card said so", never "the wrong zone was
 * written".
 */
export class DnsProviderRegistry implements DnsProvider {
  readonly name = "dns-registry" as const;

  constructor(
    private readonly providers: Partial<Record<DomainDnsProvider, DnsProvider>>,
    private readonly fallback: DnsProvider,
  ) {}

  /** The provider that answers for a domain whose `dns_provider` reads `key`. */
  for(key: DomainDnsProvider | string | null | undefined): DnsProvider {
    if (!key) return this.fallback;
    return this.providers[key as DomainDnsProvider] ?? this.fallback;
  }

  async updateRecord(input: DnsRecordChange): Promise<DnsRecordResult> {
    return this.for(input.provider).updateRecord(input);
  }

  async deleteRecord(input: DnsRecordRemoval): Promise<DnsRecordResult> {
    const provider = this.for(input.provider);
    if (!provider.deleteRecord) {
      throw new Error(`dns provider ${provider.name} cannot delete records`);
    }
    return provider.deleteRecord(input);
  }
}

/** The env fields DNS provider selection reads. */
export interface DnsEnv {
  readonly HOSTINGER_API_TOKEN?: string | undefined;
  readonly CLOUDFLARE_API_TOKEN?: string | undefined;
}

/** A blank variable is an unset one, matching every other factory here. */
function token(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Real providers where a token exists, mocks everywhere else. Each half is
 * independent: a deployment with only `HOSTINGER_API_TOKEN` writes Hostinger
 * zones for real and mocks Cloudflare ones, and the approval card names which
 * of the two a given domain will get.
 */
export function createDnsProvidersFromEnv(env: DnsEnv): DnsProviderRegistry {
  const hostingerToken = token(env.HOSTINGER_API_TOKEN);
  const cloudflareToken = token(env.CLOUDFLARE_API_TOKEN);
  return new DnsProviderRegistry(
    {
      hostinger: hostingerToken ? new HostingerDnsProvider({ token: hostingerToken }) : new MockHostingerDns(),
      cloudflare: cloudflareToken ? new CloudflareDnsProvider({ token: cloudflareToken }) : new MockCloudflareDns(),
    },
    // `registrar` and `other` mean "nobody we have an API for".
    new MockDnsProvider("mock-dns"),
  );
}
