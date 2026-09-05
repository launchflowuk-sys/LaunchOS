/**
 * Coolify adapter tests. `fetch` is stubbed throughout — nothing here touches a
 * network, and the fixtures are the response shapes Coolify 4.x actually
 * returns (Laravel timestamps, `"running:healthy"` status strings, a
 * `destination.server` the application is deployed to, and a `/servers/{uuid}`
 * record whose `settings` carry reachability but no usage).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoolifyHostingProvider,
  HostingAuthError,
  HostingRefNotFound,
  HostingRequestFailed,
  HostingTimeout,
  MockHostingProvider,
  createHostingProviderFromEnv,
  isHostingRefNotFound,
} from "./index.js";

const API_URL = "https://coolify.launchflow.test";
const TOKEN = "1|abcdef0123456789";
const APP_UUID = "vgsco4008wwwso888k4wgw8o";
const SERVER_UUID = "rg8ks8cok0sc8w0osgw8ck4o";

/** `GET /api/v1/applications/{uuid}` on a healthy app deployed to a named server. */
const APPLICATION_RUNNING = {
  id: 14,
  uuid: APP_UUID,
  name: "grayscabline-web",
  description: null,
  fqdn: "https://grayscabline.co.uk",
  git_repository: "https://github.com/launchflow/grayscabline",
  git_branch: "main",
  build_pack: "nixpacks",
  ports_exposes: "3000",
  status: "running:healthy",
  created_at: "2026-05-11T08:12:44.000000Z",
  updated_at: "2026-09-03T21:41:09.000000Z",
  last_online_at: "2026-09-03T21:42:15.000000Z",
  destination_type: "App\\Models\\StandaloneDocker",
  destination_id: 1,
  destination: {
    id: 1,
    uuid: "e8wcw8ck0wg8kokccwo0ckcs",
    name: "coolify",
    network: "coolify",
    server_id: 0,
    server: { id: 0, uuid: SERVER_UUID, name: "hetzner-cx41", ip: "10.0.0.4" },
  },
};

/** `GET /api/v1/servers/{uuid}` — reachability lives in `settings`, usage nowhere. */
const SERVER_RECORD = {
  id: 0,
  uuid: SERVER_UUID,
  name: "hetzner-cx41",
  description: "LaunchFlow production",
  ip: "10.0.0.4",
  port: 22,
  user: "root",
  settings: {
    id: 1,
    server_id: 0,
    is_reachable: true,
    is_usable: true,
    is_build_server: false,
    concurrent_builds: 2,
    server_disk_usage_notification_threshold: 80,
  },
  proxy: { type: "traefik", status: "running" },
};

/** `GET /api/v1/servers/{uuid}/resources` on a build that publishes usage alongside the list. */
const SERVER_RESOURCES_WITH_USAGE = {
  cpu_usage_percent: 37.44,
  memory_usage_percent: 62.1,
  disk_usage_percent: 55,
  uptime_seconds: 5_123_456,
  resources: [{ id: 14, uuid: APP_UUID, name: "grayscabline-web", type: "application", status: "running:healthy" }],
};

/** The same endpoint on a build that returns only the list — the common case. */
const SERVER_RESOURCES_LIST_ONLY = [
  { id: 14, uuid: APP_UUID, name: "grayscabline-web", type: "application", status: "running:healthy" },
  { id: 21, uuid: "n8os0kg0oo8gws0swkgw8s0c", name: "grayscabline-db", type: "postgresql", status: "running:healthy" },
];

interface StubRoute {
  status?: number;
  json?: unknown;
  text?: string;
}

interface StubCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Routes by path suffix (`/applications/{uuid}`), longest match first so
 * `/servers/x/resources` never answers for `/servers/x`. Any unrouted path is a
 * test failure rather than a silent 404.
 */
function stubFetch(routes: Record<string, StubRoute>): StubCall[] {
  const calls: StubCall[] = [];
  const paths = Object.keys(routes).sort((a, b) => b.length - a.length);
  vi.stubGlobal("fetch", async (input: string, init: RequestInit) => {
    const url = String(input);
    const headers = init.headers as Record<string, string>;
    calls.push({ url, method: init.method ?? "GET", headers });
    const match = paths.find((path) => url.endsWith(path));
    if (!match) throw new Error(`unrouted request: ${init.method ?? "GET"} ${url}`);
    const route = routes[match]!;
    const body = route.text ?? JSON.stringify(route.json ?? {});
    return new Response(body, {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

function provider(overrides: Partial<{ serverUuid: string; timeoutMs: number }> = {}): CoolifyHostingProvider {
  return new CoolifyHostingProvider({ apiUrl: API_URL, apiToken: TOKEN, ...overrides });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createHostingProviderFromEnv", () => {
  it("returns the mock unless both the url and the token are set, and never touches the network", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    for (const env of [
      {},
      { COOLIFY_API_URL: API_URL },
      { COOLIFY_API_TOKEN: TOKEN },
      { COOLIFY_API_URL: "  ", COOLIFY_API_TOKEN: TOKEN },
      { COOLIFY_API_URL: API_URL, COOLIFY_API_TOKEN: "" },
    ]) {
      expect(createHostingProviderFromEnv(env).name, JSON.stringify(env)).toBe("mock-coolify");
    }
    expect(createHostingProviderFromEnv({ COOLIFY_API_URL: API_URL, COOLIFY_API_TOKEN: TOKEN }).name).toBe("coolify");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a url that is not http(s) rather than silently downgrading to the mock", () => {
    expect(() => createHostingProviderFromEnv({ COOLIFY_API_URL: "coolify.test", COOLIFY_API_TOKEN: TOKEN })).toThrow(
      /not a valid URL/,
    );
    expect(() =>
      createHostingProviderFromEnv({ COOLIFY_API_URL: "ftp://coolify.test", COOLIFY_API_TOKEN: TOKEN }),
    ).toThrow(/must be http or https/);
  });

  it("honours COOLIFY_SERVER_UUID and COOLIFY_TIMEOUT_MS, ignoring an unusable timeout", async () => {
    const calls = stubFetch({
      [`/applications/${APP_UUID}`]: { json: { uuid: APP_UUID, status: "running:healthy" } },
      [`/servers/${SERVER_UUID}`]: { json: SERVER_RECORD },
      [`/servers/${SERVER_UUID}/resources`]: { json: SERVER_RESOURCES_LIST_ONLY },
    });
    const hosting = createHostingProviderFromEnv({
      COOLIFY_API_URL: API_URL,
      COOLIFY_API_TOKEN: TOKEN,
      COOLIFY_SERVER_UUID: SERVER_UUID,
      COOLIFY_TIMEOUT_MS: "nonsense",
    });
    await hosting.getResources(APP_UUID);
    // The application record named no server, so the env uuid was used.
    expect(calls.map((call) => call.url)).toContain(`${API_URL}/api/v1/servers/${SERVER_UUID}`);
  });
});

describe("CoolifyHostingProvider request shape", () => {
  it("appends /api/v1 to an instance root and accepts a url that already has it", async () => {
    for (const apiUrl of [API_URL, `${API_URL}/`, `${API_URL}/api/v1`, `${API_URL}/api/v1/`]) {
      const calls = stubFetch({ [`/applications/${APP_UUID}`]: { json: { uuid: APP_UUID, status: "exited" } } });
      await new CoolifyHostingProvider({ apiUrl, apiToken: TOKEN }).getResources(APP_UUID);
      expect(calls[0]?.url, apiUrl).toBe(`${API_URL}/api/v1/applications/${APP_UUID}`);
      vi.unstubAllGlobals();
    }
  });

  it("sends the bearer token and asks for json", async () => {
    const calls = stubFetch({ [`/applications/${APP_UUID}`]: { json: { uuid: APP_UUID, status: "exited" } } });
    await provider().getResources(APP_UUID);
    expect(calls[0]?.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, Accept: "application/json" });
  });
});

describe("CoolifyHostingProvider.getResources", () => {
  it("maps a running application and the usage its server publishes on /resources", async () => {
    const calls = stubFetch({
      [`/applications/${APP_UUID}`]: { json: APPLICATION_RUNNING },
      [`/servers/${SERVER_UUID}`]: { json: SERVER_RECORD },
      [`/servers/${SERVER_UUID}/resources`]: { json: SERVER_RESOURCES_WITH_USAGE },
    });

    await expect(provider().getResources(APP_UUID)).resolves.toEqual({
      cpuPercent: 37.4,
      memoryPercent: 62.1,
      diskPercent: 55,
      lastDeployAt: "2026-09-03T21:42:15.000Z",
      status: "running",
      rawStatus: "running:healthy",
      health: "healthy",
      serverReachable: true,
      metricsAvailable: true,
    });
    expect(calls.map((call) => call.url)).toEqual([
      `${API_URL}/api/v1/applications/${APP_UUID}`,
      `${API_URL}/api/v1/servers/${SERVER_UUID}`,
      `${API_URL}/api/v1/servers/${SERVER_UUID}/resources`,
    ]);
  });

  it("reads usage straight off the server record when that build carries it, without a second call", async () => {
    const calls = stubFetch({
      [`/applications/${APP_UUID}`]: { json: APPLICATION_RUNNING },
      [`/servers/${SERVER_UUID}`]: {
        json: { ...SERVER_RECORD, metrics: { cpu_usage_percent: 8, memory_usage_percent: 30.05, disk_usage_percent: 71 } },
      },
    });

    const resources = await provider().getResources(APP_UUID);
    expect(resources).toMatchObject({ cpuPercent: 8, memoryPercent: 30.1, diskPercent: 71, metricsAvailable: true });
    expect(calls).toHaveLength(2);
  });

  it("reports metrics as unavailable rather than zero when no endpoint publishes them", async () => {
    stubFetch({
      [`/applications/${APP_UUID}`]: { json: APPLICATION_RUNNING },
      [`/servers/${SERVER_UUID}`]: { json: SERVER_RECORD },
      [`/servers/${SERVER_UUID}/resources`]: { json: SERVER_RESOURCES_LIST_ONLY },
    });

    await expect(provider().getResources(APP_UUID)).resolves.toMatchObject({
      cpuPercent: 0,
      memoryPercent: 0,
      diskPercent: 0,
      metricsAvailable: false,
      serverReachable: true,
      status: "running",
    });
  });

  it("treats a 404 on /servers/{uuid}/resources as an absent endpoint, not a failure", async () => {
    stubFetch({
      [`/applications/${APP_UUID}`]: { json: APPLICATION_RUNNING },
      [`/servers/${SERVER_UUID}`]: { json: SERVER_RECORD },
      [`/servers/${SERVER_UUID}/resources`]: { status: 404, json: { message: "Not found." } },
    });

    await expect(provider().getResources(APP_UUID)).resolves.toMatchObject({
      metricsAvailable: false,
      serverReachable: true,
      status: "running",
    });
  });

  it("carries a server that reports itself unreachable through to the caller", async () => {
    stubFetch({
      [`/applications/${APP_UUID}`]: { json: { ...APPLICATION_RUNNING, status: "exited:unhealthy" } },
      [`/servers/${SERVER_UUID}`]: {
        json: { ...SERVER_RECORD, settings: { ...SERVER_RECORD.settings, is_reachable: false, is_usable: false } },
      },
      [`/servers/${SERVER_UUID}/resources`]: { json: SERVER_RESOURCES_LIST_ONLY },
    });

    await expect(provider().getResources(APP_UUID)).resolves.toMatchObject({
      status: "exited",
      rawStatus: "exited:unhealthy",
      health: "unhealthy",
      serverReachable: false,
      metricsAvailable: false,
    });
  });

  it("still diagnoses the application when the server call fails outright", async () => {
    stubFetch({
      [`/applications/${APP_UUID}`]: { json: { ...APPLICATION_RUNNING, status: "restarting" } },
      [`/servers/${SERVER_UUID}`]: { status: 500, text: "upstream error" },
    });

    await expect(provider().getResources(APP_UUID)).resolves.toMatchObject({
      status: "restarting",
      serverReachable: false,
      metricsAvailable: false,
    });
  });

  it("omits server facts entirely when nothing names a server", async () => {
    stubFetch({ [`/applications/${APP_UUID}`]: { json: { uuid: APP_UUID, status: "running:healthy", updated_at: null } } });

    const resources = await provider().getResources(APP_UUID);
    expect(resources).toEqual({
      cpuPercent: 0,
      memoryPercent: 0,
      diskPercent: 0,
      lastDeployAt: "",
      status: "running",
      rawStatus: "running:healthy",
      health: "healthy",
      metricsAvailable: false,
    });
    expect("serverReachable" in resources).toBe(false);
  });

  it("falls back from last_online_at to updated_at to created_at for the deploy time", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ last_online_at: null, updated_at: "2026-09-03T21:41:09.000000Z" }, "2026-09-03T21:41:09.000Z"],
      [{ last_online_at: null, updated_at: null, created_at: "2026-05-11T08:12:44.000000Z" }, "2026-05-11T08:12:44.000Z"],
      [{ last_online_at: "not a date", updated_at: "2026-09-03T21:41:09.000000Z" }, "2026-09-03T21:41:09.000Z"],
    ];
    for (const [patch, expected] of cases) {
      stubFetch({ [`/applications/${APP_UUID}`]: { json: { uuid: APP_UUID, status: "running:healthy", ...patch } } });
      await expect(provider().getResources(APP_UUID), JSON.stringify(patch)).resolves.toMatchObject({
        lastDeployAt: expected,
      });
      vi.unstubAllGlobals();
    }
  });

  it("collapses every Coolify status string onto the three states, keeping the original", async () => {
    const cases: [string, string][] = [
      ["running:healthy", "running"],
      ["running:unhealthy", "running"],
      ["exited:unhealthy", "exited"],
      ["exited", "exited"],
      ["stopped", "exited"],
      ["restarting", "restarting"],
      ["starting:health_starting", "restarting"],
      ["degraded:unhealthy", "restarting"],
      ["", "exited"],
    ];
    for (const [raw, expected] of cases) {
      stubFetch({ [`/applications/${APP_UUID}`]: { json: { uuid: APP_UUID, status: raw } } });
      await expect(provider().getResources(APP_UUID), raw).resolves.toMatchObject({ status: expected });
      vi.unstubAllGlobals();
    }
  });
});

describe("CoolifyHostingProvider errors", () => {
  it("turns a 404 on the application into a typed HostingRefNotFound naming the ref", async () => {
    stubFetch({ "/applications/nope": { status: 404, json: { message: "Application not found." } } });

    const error = await provider()
      .getResources("nope")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostingRefNotFound);
    expect(isHostingRefNotFound(error)).toBe(true);
    expect((error as HostingRefNotFound).ref).toBe("nope");
    expect((error as Error).message).toContain("hosting_ref");
  });

  it("turns 401 and 403 into an auth error that names the variable to fix", async () => {
    for (const status of [401, 403]) {
      stubFetch({ [`/applications/${APP_UUID}`]: { status, json: { message: "Unauthenticated." } } });
      const error = await provider()
        .getResources(APP_UUID)
        .catch((caught: unknown) => caught);
      expect(error, String(status)).toBeInstanceOf(HostingAuthError);
      expect((error as HostingAuthError).status).toBe(status);
      expect((error as Error).message).toContain("COOLIFY_API_TOKEN");
      vi.unstubAllGlobals();
    }
  });

  it("reports any other non-2xx with its status and a trimmed body", async () => {
    stubFetch({ [`/applications/${APP_UUID}`]: { status: 500, text: "Server Error" } });
    const error = await provider()
      .getResources(APP_UUID)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostingRequestFailed);
    expect((error as HostingRequestFailed).status).toBe(500);
    expect((error as Error).message).toContain("Server Error");
  });

  it("rejects with HostingTimeout when the instance does not answer in time", async () => {
    const aborts: string[] = [];
    vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborts.push(String(input));
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
        });
      });
    });

    await expect(provider({ timeoutMs: 20 }).getResources(APP_UUID)).rejects.toBeInstanceOf(HostingTimeout);
    await expect(provider({ timeoutMs: 20 }).getResources(APP_UUID)).rejects.toThrow(/did not respond within 20ms/);
    expect(aborts).toHaveLength(2);
  });

  it("reports a transport failure as a request failure rather than a timeout", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED 10.0.0.4:8000");
    });
    await expect(provider().getResources(APP_UUID)).rejects.toBeInstanceOf(HostingRequestFailed);
    await expect(provider().getResources(APP_UUID)).rejects.toThrow(/ECONNREFUSED/);
  });

  it("reports a non-json body as a request failure", async () => {
    stubFetch({ [`/applications/${APP_UUID}`]: { text: "<html>502 Bad Gateway</html>" } });
    await expect(provider().getResources(APP_UUID)).rejects.toThrow(/response body was not JSON/);
  });
});

describe("CoolifyHostingProvider.restart", () => {
  it("posts to the restart endpoint and maps the queued response", async () => {
    const calls = stubFetch({
      [`/applications/${APP_UUID}/restart`]: { json: { message: "Restart request queued." } },
    });

    await expect(provider().restart(APP_UUID)).resolves.toEqual({
      ref: APP_UUID,
      accepted: true,
      message: "Restart request queued.",
    });
    expect(calls[0]).toMatchObject({ url: `${API_URL}/api/v1/applications/${APP_UUID}/restart`, method: "POST" });
  });

  it("carries the deployment uuid through when Coolify returns one", async () => {
    stubFetch({
      [`/applications/${APP_UUID}/restart`]: {
        json: { message: "Restart request queued.", deployment_uuid: "n8os0kg0oo8gws0swkgw8s0c" },
      },
    });
    await expect(provider().restart(APP_UUID)).resolves.toMatchObject({
      deploymentUuid: "n8os0kg0oo8gws0swkgw8s0c",
    });
  });

  it("raises HostingRefNotFound for an unknown ref", async () => {
    stubFetch({ "/applications/nope/restart": { status: 404, json: { message: "Application not found." } } });
    await expect(provider().restart("nope")).rejects.toBeInstanceOf(HostingRefNotFound);
  });
});

describe("CoolifyHostingProvider.listApplications", () => {
  it("maps every application and skips rows with no uuid", async () => {
    stubFetch({
      "/applications": {
        json: [
          APPLICATION_RUNNING,
          { id: 21, uuid: "n8os0kg0oo8gws0swkgw8s0c", name: "masjid-web", fqdn: null, status: "exited:unhealthy" },
          { id: 22, name: "half a row" },
        ],
      },
    });

    await expect(provider().listApplications()).resolves.toEqual([
      {
        ref: APP_UUID,
        name: "grayscabline-web",
        fqdn: "https://grayscabline.co.uk",
        status: "running",
        rawStatus: "running:healthy",
      },
      {
        ref: "n8os0kg0oo8gws0swkgw8s0c",
        name: "masjid-web",
        fqdn: null,
        status: "exited",
        rawStatus: "exited:unhealthy",
      },
    ]);
  });

  it("returns nothing when the instance answers with something that is not a list", async () => {
    stubFetch({ "/applications": { json: { message: "unexpected" } } });
    await expect(provider().listApplications()).resolves.toEqual([]);
  });
});

describe("MockHostingProvider", () => {
  it("keeps its healthy defaults, applies per-ref overrides and records restarts", async () => {
    const mock = new MockHostingProvider({ app_1: { status: "exited" } });
    expect(mock.name).toBe("mock-coolify");
    await expect(mock.getResources("app_1")).resolves.toMatchObject({ status: "exited", cpuPercent: 12 });
    await expect(mock.getResources("anything-else")).resolves.toMatchObject({ status: "running" });

    await expect(mock.restart("app_1")).resolves.toEqual({ ref: "app_1", accepted: true, message: "mock restart queued" });
    expect(mock.restarts).toEqual(["app_1"]);
    await expect(mock.listApplications()).resolves.toEqual([
      { ref: "app_1", name: "app_1", fqdn: null, status: "exited", rawStatus: "exited" },
    ]);
  });
});
