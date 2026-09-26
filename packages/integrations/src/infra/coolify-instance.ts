import { infraRequest } from "./http.js";

export interface CoolifyResource {
  uuid: string;
  name: string;
  kind: "application" | "database" | "service";
  state: string;
  health: string | null;
  fqdn: string | null;
}
export interface CoolifyInstanceClient {
  version(): Promise<string>;
  resources(): Promise<CoolifyResource[]>;
  deploy(appUuid: string): Promise<{ deploymentUuid: string | null }>;
}

type Raw = { uuid?: string; name?: string; status?: string | null; fqdn?: string | null };

/** "running:healthy" → state + health. Coolify reports "unknown" health when no check is configured. */
function split(status: string | null | undefined): { state: string; health: string | null } {
  const [state = "unknown", health = null] = (status ?? "unknown").split(":");
  return { state, health };
}

export function coolifyInstanceClient(baseUrl: string, token: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): CoolifyInstanceClient {
  if (token.startsWith("mock_")) return mockCoolifyInstanceClient();
  const root = baseUrl.replace(/\/+$/, "") + "/api/v1";
  const req = (path: string, init: { method?: string; text?: boolean } = {}) =>
    infraRequest(root + path, {
      token,
      timeoutMs: opts.timeoutMs ?? 5000,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(init.method ? { method: init.method } : {}),
      ...(init.text !== undefined ? { text: init.text } : {}),
    });
  const list = async (path: string, kind: CoolifyResource["kind"]) =>
    ((await req(path)) as Raw[] ?? []).map((r): CoolifyResource => ({ uuid: r.uuid ?? "", name: r.name ?? "(unnamed)", kind, ...split(r.status), fqdn: r.fqdn ?? null }));
  return {
    version: async () => String(await req("/version", { text: true })).trim(),
    resources: async () => (await Promise.all([list("/applications", "application"), list("/databases", "database"), list("/services", "service")])).flat(),
    async deploy(uuid) {
      // Coolify 4.x: GET /deploy now answers 405 "This endpoint has changed to a POST request." — must POST, uuid still in the query string.
      const body = (await req(`/deploy?uuid=${encodeURIComponent(uuid)}`, { method: "POST" })) as { deployments?: { deployment_uuid?: string }[] } | null;
      return { deploymentUuid: body?.deployments?.[0]?.deployment_uuid ?? null };
    },
  };
}

export function mockCoolifyInstanceClient(): CoolifyInstanceClient {
  return {
    version: async () => "4.3.23-mock",
    resources: async () => [
      { uuid: "mock-app", name: "mock-web", kind: "application", state: "running", health: "healthy", fqdn: "https://mock.test" },
      { uuid: "mock-down", name: "mock-backend", kind: "application", state: "exited", health: "unhealthy", fqdn: null },
      { uuid: "mock-db", name: "mock-postgres", kind: "database", state: "running", health: "healthy", fqdn: null },
    ],
    deploy: async () => ({ deploymentUuid: "mock-deployment" }),
  };
}
