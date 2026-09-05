/**
 * Hosting: the shape the Hosting Guard-Dog reads, the mock it runs on by
 * default, and the factory that swaps in the real Coolify client.
 *
 * The interface is deliberately provider-shaped rather than Coolify-shaped —
 * `ref` is whatever `sites.hosting_ref` holds, which for Coolify is an
 * application UUID. See `coolify.ts` for the real adapter and what each field
 * is read from.
 */
import { CoolifyHostingProvider } from "./coolify.js";

export { CoolifyHostingProvider } from "./coolify.js";
export {
  HostingAuthError,
  HostingRefNotFound,
  HostingRequestFailed,
  HostingTimeout,
  isHostingRefNotFound,
} from "./coolify.js";
export type { CoolifyConfig } from "./coolify.js";

/**
 * Container state, collapsed to the three cases a diagnosis cares about.
 * Coolify's own status string is richer and survives in `rawStatus`.
 */
export type HostingStatus = "running" | "exited" | "restarting";

/** Docker health-check verdict, when the provider reports one. */
export type HostingHealth = "healthy" | "unhealthy" | "starting" | "unknown";

export interface HostingResources {
  /** 0–100. Server-wide, not per-container. 0 when `metricsAvailable` is false. */
  cpuPercent: number;
  /** 0–100. Server-wide, not per-container. 0 when `metricsAvailable` is false. */
  memoryPercent: number;
  /** 0–100. Server-wide, not per-container. 0 when `metricsAvailable` is false. */
  diskPercent: number;
  /** ISO 8601, or `""` when the provider reports no deployment timestamp. */
  lastDeployAt: string;
  status: HostingStatus;
  /** The provider's own status string, e.g. `"running:healthy"`. Absent on the mock. */
  rawStatus?: string;
  health?: HostingHealth;
  /**
   * False when the application's server could not be identified or reported
   * itself unreachable. CPU, memory and disk are then meaningless.
   */
  serverReachable?: boolean;
  /**
   * False when the server was reached but published no usage figures — not every
   * Coolify build exposes them. CPU, memory and disk are 0 and mean "unknown",
   * not "idle"; anything reading them must check this first.
   */
  metricsAvailable?: boolean;
}

/** One application known to the hosting provider. */
export interface HostingApplication {
  /** The value that belongs in `sites.hosting_ref`. */
  ref: string;
  name: string;
  fqdn: string | null;
  status: HostingStatus;
  rawStatus: string;
}

export interface HostingRestartResult {
  ref: string;
  /** True when the provider accepted the restart. It is queued, not finished. */
  accepted: boolean;
  message: string;
  /** Present when the provider returned a deployment to follow. */
  deploymentUuid?: string;
}

export interface HostingProvider {
  readonly name: "mock-coolify" | "coolify";
  getResources(ref: string): Promise<HostingResources>;
  /**
   * Restarts one application. **Acts on the outside world** — any agent tool
   * wrapping this must be `risk: "requires_approval"`.
   */
  restart(ref: string): Promise<HostingRestartResult>;
  listApplications(): Promise<HostingApplication[]>;
}

const MOCK_DEFAULTS: HostingResources = {
  cpuPercent: 12,
  memoryPercent: 41,
  diskPercent: 55,
  lastDeployAt: "2026-09-01T09:00:00Z",
  status: "running",
};

/**
 * Answers for any ref, from per-ref overrides layered over one healthy default.
 * Restarts are recorded rather than performed.
 */
export class MockHostingProvider implements HostingProvider {
  readonly name = "mock-coolify" as const;
  readonly restarts: string[] = [];

  constructor(private readonly overrides: Record<string, Partial<HostingResources>> = {}) {}

  async getResources(ref: string): Promise<HostingResources> {
    return { ...MOCK_DEFAULTS, ...this.overrides[ref] };
  }

  async restart(ref: string): Promise<HostingRestartResult> {
    this.restarts.push(ref);
    return { ref, accepted: true, message: "mock restart queued" };
  }

  /** The refs the mock was configured with — an empty list when it has none. */
  async listApplications(): Promise<HostingApplication[]> {
    return Object.entries(this.overrides).map(([ref, override]) => ({
      ref,
      name: ref,
      fqdn: null,
      status: override.status ?? MOCK_DEFAULTS.status,
      rawStatus: override.status ?? MOCK_DEFAULTS.status,
    }));
  }
}

/** The environment fields hosting selection reads. */
export interface HostingEnv {
  readonly COOLIFY_API_URL?: string | undefined;
  readonly COOLIFY_API_TOKEN?: string | undefined;
  readonly COOLIFY_SERVER_UUID?: string | undefined;
  readonly COOLIFY_TIMEOUT_MS?: string | undefined;
}

function blankAsUnset(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * The real Coolify client when both `COOLIFY_API_URL` and `COOLIFY_API_TOKEN`
 * are set, the mock otherwise. Constructs only — the first HTTP request happens
 * on the first call, so a wrong token cannot take a process down at boot.
 *
 * A `COOLIFY_API_URL` that is not a valid http(s) URL **throws** here rather
 * than falling back: a silent downgrade to the mock would report every site
 * healthy with no failure anywhere. Half-set (URL without token, or the reverse)
 * is treated as unset, which the production adapter guard is the right place to
 * refuse.
 */
export function createHostingProviderFromEnv(env: HostingEnv): HostingProvider {
  const apiUrl = blankAsUnset(env.COOLIFY_API_URL);
  const apiToken = blankAsUnset(env.COOLIFY_API_TOKEN);
  if (!apiUrl || !apiToken) return new MockHostingProvider();
  const serverUuid = blankAsUnset(env.COOLIFY_SERVER_UUID);
  const timeoutMs = Number(blankAsUnset(env.COOLIFY_TIMEOUT_MS));
  return new CoolifyHostingProvider({
    apiUrl,
    apiToken,
    ...(serverUuid ? { serverUuid } : {}),
    ...(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  });
}
