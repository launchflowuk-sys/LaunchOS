/**
 * The real Coolify client, against the v4 REST API (`<COOLIFY_API_URL>/api/v1`,
 * bearer token).
 *
 * Three endpoints, in this order, for one `getResources` call:
 *
 * | Endpoint | What we take from it |
 * |---|---|
 * | `GET /applications/{uuid}` | container state (`status`), the deployment timestamp, and the server the application is deployed to |
 * | `GET /servers/{uuid}` | whether that server is reachable, and usage figures when the build publishes them |
 * | `GET /servers/{uuid}/resources` | usage figures on the builds that expose them there instead |
 *
 * **Coolify does not guarantee server CPU/memory/disk on any of them.** Several
 * 4.x builds return only the server record and a list of the resources running
 * on it, with no usage anywhere. That is why the mapping hunts for the figures
 * across a handful of shapes and reports `metricsAvailable: false` rather than
 * inventing zeros — a guard-dog that reads `cpuPercent: 0` as "idle" on a box
 * that is actually on fire is worse than one that reads "unknown".
 *
 * Response parsing is lenient by design: every field is optional and unknown
 * keys are dropped, so a Coolify upgrade that adds or renames a field degrades
 * one value instead of failing the whole call.
 */
import { z } from "zod";
import type {
  HostingApplication,
  HostingHealth,
  HostingProvider,
  HostingResources,
  HostingRestartResult,
  HostingStatus,
} from "./index.js";

/** The ref is not an application Coolify knows about. Callers can act on this one. */
export class HostingRefNotFound extends Error {
  readonly ref: string;

  constructor(ref: string) {
    super(`Coolify has no application with uuid "${ref}" (check sites.hosting_ref)`);
    this.name = "HostingRefNotFound";
    this.ref = ref;
  }
}

/** 401 or 403: the token is missing, wrong, expired, or lacks the permission. */
export class HostingAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      `Coolify rejected the API token (HTTP ${status}). Check COOLIFY_API_TOKEN is a current token ` +
        `for this instance and that its team can read the application.`,
    );
    this.name = "HostingAuthError";
    this.status = status;
  }
}

/** Any other non-2xx, with the status and a trimmed body for the run trace. */
export class HostingRequestFailed extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number, body: string) {
    super(`Coolify ${method} ${path} failed with HTTP ${status}${body ? `: ${body}` : ""}`);
    this.name = "HostingRequestFailed";
    this.status = status;
  }
}

/** The request did not answer inside `timeoutMs`. */
export class HostingTimeout extends Error {
  constructor(method: string, path: string, timeoutMs: number) {
    super(`Coolify ${method} ${path} did not respond within ${timeoutMs}ms`);
    this.name = "HostingTimeout";
  }
}

export function isHostingRefNotFound(error: unknown): error is HostingRefNotFound {
  return error instanceof HostingRefNotFound;
}

export interface CoolifyConfig {
  /** The instance root (`https://coolify.example.com`) or its API base; `/api/v1` is appended when absent. */
  apiUrl: string;
  /** A Coolify API token. Never logged. */
  apiToken: string;
  /** Used when an application record does not name its own server. */
  serverUuid?: string;
  /** Per-request budget. Default 10s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_CHARS = 500;

const ServerRef = z.object({ uuid: z.string().nullish() }).nullish();

const CoolifyApplicationSchema = z.object({
  uuid: z.string().nullish(),
  name: z.string().nullish(),
  fqdn: z.string().nullish(),
  status: z.string().nullish(),
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
  last_online_at: z.string().nullish(),
  server_uuid: z.string().nullish(),
  server: ServerRef,
  destination: z.object({ server_uuid: z.string().nullish(), server: ServerRef }).nullish(),
});
type CoolifyApplication = z.infer<typeof CoolifyApplicationSchema>;

const CoolifyServerSchema = z.object({
  uuid: z.string().nullish(),
  name: z.string().nullish(),
  settings: z.object({ is_reachable: z.boolean().nullish(), is_usable: z.boolean().nullish() }).nullish(),
});

const CoolifyRestartSchema = z.object({ message: z.string().nullish(), deployment_uuid: z.string().nullish() });

/** Usage keys seen across Coolify 4.x builds and their Sentinel payloads, most specific first. */
const CPU_KEYS = ["cpu_usage_percent", "cpu_percent", "cpu_usage", "cpu"];
const MEMORY_KEYS = ["memory_usage_percent", "memory_percent", "memory_usage", "ram_usage_percent", "memory"];
const DISK_KEYS = ["disk_usage_percent", "disk_percent", "disk_usage", "disk"];
/** Objects the figures are sometimes nested inside. */
const METRIC_CONTAINERS = ["metrics", "usage", "stats", "server", "resources"];

export class CoolifyHostingProvider implements HostingProvider {
  readonly name = "coolify" as const;

  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly serverUuid: string | undefined;
  private readonly timeoutMs: number;

  /** Validates the URL and stores the token. Performs no I/O. */
  constructor(config: CoolifyConfig) {
    this.baseUrl = normaliseBaseUrl(config.apiUrl);
    this.apiToken = config.apiToken;
    this.serverUuid = config.serverUuid;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async getResources(ref: string): Promise<HostingResources> {
    const path = `/applications/${encodeURIComponent(ref)}`;
    const parsed = CoolifyApplicationSchema.safeParse(await this.request("GET", path, { ref }));
    if (!parsed.success) throw new HostingRequestFailed("GET", path, 200, "response was not an application object");
    const app = parsed.data;
    const serverUuid = serverUuidOf(app) ?? this.serverUuid;
    const server = serverUuid ? await this.readServer(serverUuid) : null;
    const health = healthOf(app.status);
    return {
      cpuPercent: server?.usage.cpuPercent ?? 0,
      memoryPercent: server?.usage.memoryPercent ?? 0,
      diskPercent: server?.usage.diskPercent ?? 0,
      lastDeployAt: lastDeployAtOf(app),
      status: mapStatus(app.status),
      rawStatus: app.status ?? "unknown",
      ...(health ? { health } : {}),
      ...(server ? { serverReachable: server.reachable } : {}),
      metricsAvailable: server?.usage.available ?? false,
    };
  }

  /**
   * Queues a restart. Coolify answers as soon as the job is queued, so
   * `accepted` means "Coolify took the request", never "the app is back".
   */
  async restart(ref: string): Promise<HostingRestartResult> {
    const path = `/applications/${encodeURIComponent(ref)}/restart`;
    const parsed = CoolifyRestartSchema.safeParse(await this.request("POST", path, { ref }));
    const body: z.infer<typeof CoolifyRestartSchema> = parsed.success ? parsed.data : {};
    return {
      ref,
      accepted: true,
      message: body.message ?? "restart queued",
      ...(body.deployment_uuid ? { deploymentUuid: body.deployment_uuid } : {}),
    };
  }

  /** Every application on the instance, for matching `sites.hosting_ref` against reality. */
  async listApplications(): Promise<HostingApplication[]> {
    const rows = z.array(CoolifyApplicationSchema).safeParse(await this.request("GET", "/applications"));
    if (!rows.success) return [];
    const applications: HostingApplication[] = [];
    for (const row of rows.data) {
      if (!row.uuid) continue;
      applications.push({
        ref: row.uuid,
        name: row.name ?? row.uuid,
        fqdn: row.fqdn ?? null,
        status: mapStatus(row.status),
        rawStatus: row.status ?? "unknown",
      });
    }
    return applications;
  }

  /**
   * Reachability and usage for one server. A server that cannot be described is
   * reported as unreachable with no metrics rather than failing the whole
   * diagnosis — the application status above it is the part that matters, and
   * both facts are visible in the returned object. An auth failure still throws:
   * that is configuration, not a sick server.
   */
  private async readServer(uuid: string): Promise<{ reachable: boolean; usage: Usage }> {
    const path = `/servers/${encodeURIComponent(uuid)}`;
    let body: unknown;
    try {
      body = await this.request("GET", path);
    } catch (error) {
      if (error instanceof HostingAuthError) throw error;
      return { reachable: false, usage: NO_USAGE };
    }
    const server = CoolifyServerSchema.safeParse(body);
    const reachable = server.success ? (server.data.settings?.is_reachable ?? true) : true;
    const usage = readUsage(body);
    if (usage.available) return { reachable, usage };
    return { reachable, usage: await this.readServerResourceUsage(path) };
  }

  /** `/servers/{uuid}/resources` on the builds that have it; absent is not an error. */
  private async readServerResourceUsage(serverPath: string): Promise<Usage> {
    try {
      return readUsage(await this.request("GET", `${serverPath}/resources`));
    } catch (error) {
      if (error instanceof HostingAuthError) throw error;
      return NO_USAGE;
    }
  }

  /**
   * One authenticated request. Non-2xx becomes a typed error; the 10s budget is
   * enforced with an AbortController so a hung Coolify cannot hold an agent run
   * open. `ref` turns a 404 into `HostingRefNotFound` for the calls where a 404
   * means the ref is wrong rather than the endpoint being absent.
   */
  private async request(method: "GET" | "POST", path: string, options: { ref?: string } = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiToken}`, Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new HostingTimeout(method, path, this.timeoutMs);
      throw new HostingRequestFailed(method, path, 0, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) throw new HostingAuthError(response.status);
    if (response.status === 404 && options.ref !== undefined) throw new HostingRefNotFound(options.ref);
    if (!response.ok) {
      const body = (await safeText(response)).slice(0, MAX_ERROR_BODY_CHARS);
      throw new HostingRequestFailed(method, path, response.status, body);
    }
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new HostingRequestFailed(method, path, response.status, "response body was not JSON");
    }
  }
}

interface Usage {
  available: boolean;
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
}

const NO_USAGE: Usage = { available: false, cpuPercent: 0, memoryPercent: 0, diskPercent: 0 };

/** `https://coolify.example.com/` and `.../api/v1` both become `.../api/v1`. */
function normaliseBaseUrl(apiUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error(`COOLIFY_API_URL is not a valid URL: "${apiUrl}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`COOLIFY_API_URL must be http or https, got "${parsed.protocol}"`);
  }
  const trimmed = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

/** Where the application says it is deployed, across the shapes 4.x has used. */
function serverUuidOf(app: CoolifyApplication): string | undefined {
  const uuid =
    app.destination?.server?.uuid ?? app.destination?.server_uuid ?? app.server?.uuid ?? app.server_uuid;
  return uuid ?? undefined;
}

/**
 * Coolify reports `"<container state>:<health>"`, e.g. `"running:healthy"`.
 * Anything that is not running or on its way there is `exited` — the field
 * drives a diagnosis, and `rawStatus` carries the detail.
 */
function mapStatus(raw: string | null | undefined): HostingStatus {
  const state = (raw ?? "").split(":")[0]?.trim().toLowerCase() ?? "";
  if (state === "running") return "running";
  if (state === "restarting" || state === "starting" || state === "deploying" || state === "degraded") {
    return "restarting";
  }
  return "exited";
}

function healthOf(raw: string | null | undefined): HostingHealth | null {
  const suffix = (raw ?? "").split(":")[1]?.trim().toLowerCase();
  if (suffix === "healthy" || suffix === "unhealthy" || suffix === "starting") return suffix;
  return raw ? "unknown" : null;
}

/**
 * The best available "last deployed" moment. Coolify's application record has no
 * deployment field, so `last_online_at` (stamped when the container last came
 * up) is the closest thing, then `updated_at`, then `created_at`.
 */
function lastDeployAtOf(app: CoolifyApplication): string {
  for (const candidate of [app.last_online_at, app.updated_at, app.created_at]) {
    const iso = toIso(candidate);
    if (iso) return iso;
  }
  return "";
}

/** Laravel's `2026-09-03T21:42:15.000000Z` and friends, normalised. `""` when unusable. */
function toIso(value: string | null | undefined): string {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A percentage, from a number or a string like `"37.4"` / `"37.4%"`. Null when it is not one. */
function toPercent(value: unknown): number | null {
  const raw = typeof value === "string" ? Number(value.trim().replace(/%$/, "")) : value;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 100) return null;
  return Math.round(raw * 10) / 10;
}

function firstPercent(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const found = toPercent(record[key]);
    if (found !== null) return found;
  }
  return null;
}

/** Looks for a usage figure at the top level, then inside the usual wrappers. */
function findPercent(source: Record<string, unknown>, keys: readonly string[]): number | null {
  const direct = firstPercent(source, keys);
  if (direct !== null) return direct;
  for (const container of METRIC_CONTAINERS) {
    const nested = asRecord(source[container]);
    if (!nested) continue;
    const found = firstPercent(nested, keys);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Usage from whatever shape the body has. `available` is false unless at least
 * one of the three figures was actually published, so callers can tell "0%" from
 * "this build does not report it".
 */
function readUsage(body: unknown): Usage {
  const record = asRecord(body);
  if (!record) return NO_USAGE;
  const cpu = findPercent(record, CPU_KEYS);
  const memory = findPercent(record, MEMORY_KEYS);
  const disk = findPercent(record, DISK_KEYS);
  if (cpu === null && memory === null && disk === null) return NO_USAGE;
  return { available: true, cpuPercent: cpu ?? 0, memoryPercent: memory ?? 0, diskPercent: disk ?? 0 };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
