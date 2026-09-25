# Infrastructure: Servers + Coolify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Hetzner Cloud server and every Coolify app on one LaunchOS screen, with live month-to-date cost flowing into the cost register, and the everyday actions (reboot, shut down, power on, snapshot, backups, redeploy).

**Architecture:** Connections (any number of Hetzner accounts and Coolify instances) live encrypted in `infra_connections`. A 15-minute pg-boss job syncs Hetzner into `servers` and `supplier_costs`. Coolify apps are read live per page load. Actions are owner-only server actions that call the provider and write `audit_log`.

**Tech Stack:** Drizzle + Postgres 17, Zod, pg-boss, Next.js 16 server actions, Vitest (`withTestDb`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-25-infrastructure-servers-design.md`

## Global Constraints

- Every table has `organisation_id` (via `tenantColumns()`); every core function is `(db, organisationId, input)` and filters on it.
- Tokens are encrypted with `encryptSecret`/`decryptSecret` from `packages/core/src/secrets/encryption.ts`; plaintext never leaves `connections.ts` except through `connectionSecret()`; never logged, audited or returned to the browser.
- Owner only: every page and action checks `session.role === "owner"`.
- Money: Hetzner price strings → integer **EUR cents** at the boundary. No float totals. `supplier_costs` rows: `supplier "hetzner"`, `source "sync"`, `vat_treatment "reverse_charge"`, `currency_code "EUR"`, `billing_period_unit "month"`.
- A missing FX rate is never 1.0 — show € and name the missing rate.
- Mock-first: a token starting `mock_` selects the mock client. Tests never hit the network.
- Hetzner: location is `server.location.name` (no `datacenter`). Coolify: tokens contain `|`; `/api/v1/version` returns text.
- Do not run `pnpm build` while `pnpm dev` is running. Run `pnpm --filter @launchos/web build` before pushing web changes (dev stopped).
- Commit after every task. **Never push** — Shoji pushes when he says.

## File map

```
packages/db/src/schema/infrastructure.ts                  enum + infra_connections + servers
packages/integrations/src/infra/http.ts                   fetch with timeout, typed errors
packages/integrations/src/infra/hetzner.ts                Hetzner Cloud client + mock
packages/integrations/src/infra/coolify-instance.ts       per-instance Coolify client + mock
packages/integrations/src/infra/index.ts                  barrel
packages/core/src/infrastructure/cost.ts                  pure cost maths
packages/core/src/infrastructure/connections.ts           CRUD, test, encrypt, import from env
packages/core/src/infrastructure/sync.ts                  one sync run
packages/core/src/infrastructure/actions.ts               server/app actions, business tag
packages/core/src/infrastructure/index.ts                 barrel
apps/worker/src/jobs/infra-sync.ts                        job handler
apps/web/src/app/(admin)/settings/infrastructure/*        connections screen
apps/web/src/app/(admin)/servers/*                        servers screen
apps/web/tests/e2e/servers.spec.ts                        one e2e pass
```

The existing `packages/integrations/src/coolify/coolify.ts` (394 lines) is the single-server `HostingProvider` used by site deploys; it is **not** extended — a fleet-reading client is a different job and would push it past 400 lines.

---

### Task 1: Schema

**Files:**
- Create: `packages/db/src/schema/infrastructure.ts`
- Modify: `packages/db/src/schema/index.ts` (add export)
- Generate: `packages/db/drizzle/<n>_*.sql`
- Test: `packages/db/src/schema/schema.test.ts` (extend if it lists tables; otherwise covered by Task 5 tests)

**Interfaces — Produces:** `schema.infraProviderEnum`, `schema.infraConnections`, `schema.servers`, types `ServerCost`, `ServerMetrics`, `PendingAction`.

- [ ] **Step 1: Write the schema**

```ts
import { bigint, boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { costBusinessEnum } from "./supplier-costs.js";

/**
 * Where LaunchFlow's servers and apps live. One value per provider; adding a
 * host is a new value plus an adapter in `@launchos/integrations/infra`.
 */
export const infraProviderEnum = pgEnum("infra_provider", ["hetzner_cloud", "coolify"]);

/**
 * One API credential for one Hetzner project or one Coolify instance. Held
 * encrypted; the plaintext is read only by `connectionSecret()` in core.
 */
export const infraConnections = pgTable(
  "infra_connections",
  {
    ...tenantColumns(),
    provider: infraProviderEnum("provider").notNull(),
    label: text("label").notNull(),
    /** Coolify only (`http://1.2.3.4:8000`). Hetzner is always api.hetzner.cloud. */
    baseUrl: text("base_url"),
    tokenEncrypted: text("token_encrypted").notNull(),
    /** Coolify only: the server this instance runs on. Set by IP match or by hand. */
    serverId: uuid("server_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [
    uniqueIndex("infra_connections_label").on(t.organisationId, t.label),
    index("infra_connections_provider").on(t.organisationId, t.provider),
  ],
);

export interface ServerCost {
  /** EUR cents, net. */
  base: number; backups: number; volumes: number; primaryIps: number; snapshots: number; traffic: number;
  monthToDate: number;
  projectedMonth: number;
}
export interface ServerMetrics { from: string; step: number; cpu: number[]; diskIops: number[] }
export interface PendingAction { id: number; command: string; startedAt: string }

/** One Hetzner Cloud server, as the last sync saw it. */
export const servers = pgTable(
  "servers",
  {
    ...tenantColumns(),
    connectionId: uuid("connection_id").notNull().references(() => infraConnections.id, { onDelete: "cascade" }),
    hetznerId: bigint("hetzner_id", { mode: "number" }).notNull(),
    name: text("name").notNull(),
    serverType: text("server_type").notNull(),
    location: text("location").notNull(),
    ipv4: text("ipv4"),
    status: text("status").notNull(),
    deleteProtected: boolean("delete_protected").default(false).notNull(),
    backupsEnabled: boolean("backups_enabled").default(false).notNull(),
    includedTrafficBytes: bigint("included_traffic_bytes", { mode: "number" }).default(0).notNull(),
    outgoingTrafficBytes: bigint("outgoing_traffic_bytes", { mode: "number" }).default(0).notNull(),
    /** Set by a person on the Servers screen. The sync never writes it. */
    business: costBusinessEnum("business").default("shared").notNull(),
    metrics: jsonb("metrics").$type<ServerMetrics | null>(),
    cost: jsonb("cost").$type<ServerCost | null>(),
    pendingAction: jsonb("pending_action").$type<PendingAction | null>(),
    hetznerCreatedAt: timestamp("hetzner_created_at", { withTimezone: true }).notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("servers_external").on(t.organisationId, t.connectionId, t.hetznerId),
    index("servers_ipv4").on(t.organisationId, t.ipv4),
  ],
);
```

`infra_connections.server_id` is a plain uuid (no FK) on purpose: the two tables reference each other and a circular FK buys nothing here — `connections.ts` validates it against the org.

- [ ] **Step 2: Export** — add `export * from "./infrastructure.js";` to `packages/db/src/schema/index.ts`.

- [ ] **Step 3: Generate and review**

Run: `pnpm db:up; pnpm --filter @launchos/db generate`
Expected: one new SQL file creating `infra_provider`, `infra_connections`, `servers` and the indexes. Read it; no drops.

- [ ] **Step 4: Migrate** — `pnpm db:migrate`. Expected: applies cleanly.

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm typecheck
git add packages/db && git commit -m "feat(db): infra connections and servers"
```

---

### Task 2: HTTP helper + Hetzner client

**Files:**
- Create: `packages/integrations/src/infra/http.ts`, `packages/integrations/src/infra/hetzner.ts`, `packages/integrations/src/infra/index.ts`
- Modify: `packages/integrations/src/index.ts` (add `export * from "./infra/index.js";`)
- Test: `packages/integrations/src/infra/hetzner.test.ts`

**Interfaces — Produces:**

```ts
export class InfraAuthError extends Error {}      // 401/403
export class InfraRequestError extends Error {}   // other non-2xx, network, timeout
export type HetznerCommand = "reboot" | "shutdown" | "poweron" | "create_image" | "enable_backup" | "disable_backup";
export interface HetznerClient {
  listServers(): Promise<HetznerServer[]>;
  listVolumes(): Promise<HetznerVolume[]>;
  listPrimaryIps(): Promise<HetznerPrimaryIp[]>;
  listSnapshots(): Promise<HetznerImage[]>;
  pricing(): Promise<HetznerPricing>;
  metrics(serverId: number, from: Date, to: Date): Promise<{ cpu: number[]; diskIops: number[]; step: number }>;
  runAction(serverId: number, command: HetznerCommand, description?: string): Promise<{ id: number; status: string }>;
  getAction(actionId: number): Promise<{ id: number; status: "running" | "success" | "error"; error: string | null }>;
}
export function hetznerClient(token: string, opts?: { fetch?: typeof fetch; timeoutMs?: number }): HetznerClient; // "mock_" → mock
export function mockHetznerClient(fixture?: MockHetznerFixture): HetznerClient;
```

- [ ] **Step 1: Write `http.ts`**

```ts
export class InfraAuthError extends Error {
  constructor(readonly status: number) { super(`The provider refused the token (HTTP ${status}).`); this.name = "InfraAuthError"; }
}
export class InfraRequestError extends Error {
  constructor(message: string) { super(message); this.name = "InfraRequestError"; }
}

const MAX_BODY = 300;

/** One JSON (or text) request with a hard timeout. Never includes the token in an error. */
export async function infraRequest(
  url: string,
  init: { method?: string; token: string; body?: unknown; fetch?: typeof fetch; timeoutMs?: number; text?: boolean },
): Promise<unknown> {
  const f = init.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${init.token}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    });
  } catch (error) {
    throw new InfraRequestError(`${init.method ?? "GET"} ${new URL(url).pathname} failed: ${error instanceof Error ? error.name : "network error"}`);
  }
  if (res.status === 401 || res.status === 403) throw new InfraAuthError(res.status);
  const raw = await res.text();
  if (!res.ok) throw new InfraRequestError(`${init.method ?? "GET"} ${new URL(url).pathname} → ${res.status}: ${raw.slice(0, MAX_BODY)}`);
  if (init.text) return raw;
  return raw === "" ? null : JSON.parse(raw);
}
```

- [ ] **Step 2: Write the failing tests** (`hetzner.test.ts`)

```ts
import { describe, expect, it, vi } from "vitest";
import { hetznerClient, mockHetznerClient } from "./hetzner.js";
import { InfraAuthError } from "./http.js";

const SERVER = {
  id: 42, name: "CABIOMASTER", status: "running", created: "2026-05-20T10:00:00+00:00",
  server_type: { name: "cpx32", prices: [{ location: "fsn1", price_hourly: { net: "0.0569000000" }, price_monthly: { net: "35.4900000000" }, included_traffic: 21990232555520, price_per_tb_traffic: { net: "1.0000000000" } }] },
  location: { name: "fsn1" }, public_net: { ipv4: { ip: "178.105.149.221" } },
  protection: { delete: true }, backup_window: "22-02", included_traffic: 21990232555520, outgoing_traffic: 6_800_000_000, volumes: [],
};

function stubFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

describe("hetznerClient", () => {
  it("maps a server, reading location from server.location, prices as cents", async () => {
    const f = stubFetch({ servers: [SERVER], meta: { pagination: { next_page: null } } });
    const [s] = await hetznerClient("tok", { fetch: f }).listServers();
    expect(s).toMatchObject({ id: 42, name: "CABIOMASTER", location: "fsn1", ipv4: "178.105.149.221", deleteProtected: true, backupsEnabled: true });
    expect(s!.price).toEqual({ hourlyMicroCents: 5_690_000, monthlyCents: 3549, perTbTrafficCents: 100 });
    expect(f).toHaveBeenCalledWith(expect.stringContaining("/servers?per_page=50&page=1"), expect.anything());
  });

  it("throws InfraAuthError on 401 without leaking the token", async () => {
    const err = await hetznerClient("secret-token", { fetch: stubFetch({}, 401) }).listServers().catch((e) => e);
    expect(err).toBeInstanceOf(InfraAuthError);
    expect(String(err.message)).not.toContain("secret-token");
  });

  it("follows pagination", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [SERVER], meta: { pagination: { next_page: 2 } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ servers: [{ ...SERVER, id: 43 }], meta: { pagination: { next_page: null } } })));
    expect(await hetznerClient("tok", { fetch: f }).listServers()).toHaveLength(2);
  });

  it("uses the mock for mock_ tokens", async () => {
    expect((await hetznerClient("mock_x").listServers()).length).toBeGreaterThan(0);
  });

  it("mock runAction returns a running action that settles to success", async () => {
    const c = mockHetznerClient();
    const a = await c.runAction(1, "reboot");
    expect(a.status).toBe("running");
    expect((await c.getAction(a.id)).status).toBe("success");
  });
});
```

- [ ] **Step 3: Run** — `pnpm --filter @launchos/integrations test hetzner` → FAIL (module missing).

- [ ] **Step 4: Implement `hetzner.ts`**

```ts
import { z } from "zod";
import { infraRequest } from "./http.js";

const API = "https://api.hetzner.cloud/v1";

/** "35.4900000000" → 3549 cents. Hetzner money is a decimal string; never a float in totals. */
export function eurCents(value: string): number {
  const [whole, frac = ""] = value.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2)) + (Number(frac.slice(2, 3) || "0") >= 5 ? 1 : 0);
}
/** Hourly prices are sub-cent: keep them as millionths of a cent. */
function microCents(value: string): number {
  return Math.round(Number(value) * 100 * 1_000_000);
}

const Money = z.object({ net: z.string() });
const RawServer = z.object({
  id: z.number(), name: z.string(), status: z.string(), created: z.string(),
  server_type: z.object({ name: z.string(), prices: z.array(z.object({
    location: z.string(), price_hourly: Money, price_monthly: Money, included_traffic: z.number(), price_per_tb_traffic: Money,
  })) }),
  location: z.object({ name: z.string() }),
  public_net: z.object({ ipv4: z.object({ ip: z.string() }).nullable() }),
  protection: z.object({ delete: z.boolean() }),
  backup_window: z.string().nullable(),
  included_traffic: z.number().nullable(),
  outgoing_traffic: z.number().nullable(),
});

export interface HetznerServer {
  id: number; name: string; status: string; createdAt: Date; serverType: string; location: string; ipv4: string | null;
  deleteProtected: boolean; backupsEnabled: boolean; includedTrafficBytes: number; outgoingTrafficBytes: number;
  price: { hourlyMicroCents: number; monthlyCents: number; perTbTrafficCents: number };
}
export interface HetznerVolume { id: number; serverId: number | null; sizeGb: number }
export interface HetznerPrimaryIp { id: number; type: "ipv4" | "ipv6"; assigneeId: number | null }
export interface HetznerImage { id: number; sizeGb: number; createdFrom: number | null; description: string }
export interface HetznerPricing {
  backupPercent: number;
  imageMilliCentsPerGbMonth: number;
  volumeMilliCentsPerGbMonth: number;
  primaryIpv4MonthlyCents: Record<string, number>; // by location
}
export type HetznerCommand = "reboot" | "shutdown" | "poweron" | "create_image" | "enable_backup" | "disable_backup";
export interface HetznerAction { id: number; status: "running" | "success" | "error"; error: string | null }

export interface HetznerClient {
  listServers(): Promise<HetznerServer[]>;
  listVolumes(): Promise<HetznerVolume[]>;
  listPrimaryIps(): Promise<HetznerPrimaryIp[]>;
  listSnapshots(): Promise<HetznerImage[]>;
  pricing(): Promise<HetznerPricing>;
  metrics(serverId: number, from: Date, to: Date): Promise<{ cpu: number[]; diskIops: number[]; step: number }>;
  runAction(serverId: number, command: HetznerCommand, description?: string): Promise<HetznerAction>;
  getAction(actionId: number): Promise<HetznerAction>;
}

function mapServer(raw: unknown): HetznerServer {
  const s = RawServer.parse(raw);
  const p = s.server_type.prices.find((x) => x.location === s.location.name);
  if (!p) throw new Error(`No price for ${s.server_type.name} in ${s.location.name}`);
  return {
    id: s.id, name: s.name, status: s.status, createdAt: new Date(s.created), serverType: s.server_type.name,
    location: s.location.name, ipv4: s.public_net.ipv4?.ip ?? null, deleteProtected: s.protection.delete,
    backupsEnabled: s.backup_window !== null, includedTrafficBytes: s.included_traffic ?? p.included_traffic,
    outgoingTrafficBytes: s.outgoing_traffic ?? 0,
    price: { hourlyMicroCents: microCents(p.price_hourly.net), monthlyCents: eurCents(p.price_monthly.net), perTbTrafficCents: eurCents(p.price_per_tb_traffic.net) },
  };
}

const milli = (v: string) => Math.round(Number(v) * 100 * 1000);

export function hetznerClient(token: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): HetznerClient {
  if (token.startsWith("mock_")) return mockHetznerClient();
  const get = (path: string) => infraRequest(API + path, { token, fetch: opts.fetch, timeoutMs: opts.timeoutMs });
  const post = (path: string, body?: unknown) => infraRequest(API + path, { method: "POST", token, body: body ?? {}, fetch: opts.fetch, timeoutMs: opts.timeoutMs });

  async function paged<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const body = (await get(`${path}${sep}per_page=50&page=${page}`)) as Record<string, unknown> & { meta?: { pagination?: { next_page: number | null } } };
      out.push(...((body[key] as T[]) ?? []));
      if (!body.meta?.pagination?.next_page) return out;
    }
  }
  const action = (raw: unknown): HetznerAction => {
    const a = (raw as { action: { id: number; status: HetznerAction["status"]; error: { message: string } | null } }).action;
    return { id: a.id, status: a.status, error: a.error?.message ?? null };
  };

  return {
    listServers: async () => (await paged<unknown>("/servers", "servers")).map(mapServer),
    listVolumes: async () => (await paged<{ id: number; server: number | null; size: number }>("/volumes", "volumes"))
      .map((v) => ({ id: v.id, serverId: v.server, sizeGb: v.size })),
    listPrimaryIps: async () => (await paged<{ id: number; type: "ipv4" | "ipv6"; assignee_id: number | null }>("/primary_ips", "primary_ips"))
      .map((p) => ({ id: p.id, type: p.type, assigneeId: p.assignee_id })),
    listSnapshots: async () => (await paged<{ id: number; image_size: number | null; created_from: { id: number } | null; description: string }>("/images?type=snapshot", "images"))
      .map((i) => ({ id: i.id, sizeGb: i.image_size ?? 0, createdFrom: i.created_from?.id ?? null, description: i.description })),
    async pricing() {
      const { pricing: p } = (await get("/pricing")) as { pricing: {
        server_backup: { percentage: string }; volume: { price_per_gb_month: { net: string } }; image: { price_per_gb_month: { net: string } };
        primary_ips: { type: string; prices: { location: string; price_monthly: { net: string } }[] }[];
      } };
      const v4 = p.primary_ips.find((x) => x.type === "ipv4")?.prices ?? [];
      return {
        backupPercent: Number(p.server_backup.percentage),
        volumeMilliCentsPerGbMonth: milli(p.volume.price_per_gb_month.net),
        imageMilliCentsPerGbMonth: milli(p.image.price_per_gb_month.net),
        primaryIpv4MonthlyCents: Object.fromEntries(v4.map((x) => [x.location, eurCents(x.price_monthly.net)])),
      };
    },
    async metrics(serverId, from, to) {
      const step = 900;
      const q = `type=cpu,disk&start=${from.toISOString()}&end=${to.toISOString()}&step=${step}`;
      const body = (await get(`/servers/${serverId}/metrics?${q}`)) as { metrics: { time_series: Record<string, { values: [number, string][] }> } };
      const ts = body.metrics.time_series;
      const series = (k: string) => (ts[k]?.values ?? []).map(([, v]) => Math.round(Number(v) * 10) / 10);
      const read = series("disk.0.iops.read"); const write = series("disk.0.iops.write");
      return { step, cpu: series("cpu"), diskIops: read.map((r, i) => Math.round((r + (write[i] ?? 0)) * 10) / 10) };
    },
    runAction: async (serverId, command, description) =>
      action(await post(`/servers/${serverId}/actions/${command}`, command === "create_image" ? { type: "snapshot", description } : undefined)),
    getAction: async (id) => action(await get(`/actions/${id}`)),
  };
}
```

Mock, same file:

```ts
export interface MockHetznerFixture { servers?: HetznerServer[]; volumes?: HetznerVolume[]; primaryIps?: HetznerPrimaryIp[]; snapshots?: HetznerImage[] }

export const MOCK_SERVERS: HetznerServer[] = [
  { id: 1, name: "mock-cabio", status: "running", createdAt: new Date("2026-05-01T00:00:00Z"), serverType: "cpx32", location: "fsn1",
    ipv4: "10.9.0.1", deleteProtected: true, backupsEnabled: true, includedTrafficBytes: 21990232555520, outgoingTrafficBytes: 6_800_000_000,
    price: { hourlyMicroCents: 5_690_000, monthlyCents: 3549, perTbTrafficCents: 100 } },
  { id: 2, name: "mock-pizza", status: "running", createdAt: new Date("2026-09-05T00:00:00Z"), serverType: "cx23", location: "nbg1",
    ipv4: "10.9.0.2", deleteProtected: false, backupsEnabled: false, includedTrafficBytes: 21990232555520, outgoingTrafficBytes: 2_800_000_000,
    price: { hourlyMicroCents: 880_000, monthlyCents: 549, perTbTrafficCents: 100 } },
];

export function mockHetznerClient(fixture: MockHetznerFixture = {}): HetznerClient {
  const actions = new Map<number, HetznerAction>();
  let next = 1000;
  return {
    listServers: async () => fixture.servers ?? MOCK_SERVERS,
    listVolumes: async () => fixture.volumes ?? [{ id: 7, serverId: 2, sizeGb: 100 }],
    listPrimaryIps: async () => fixture.primaryIps ?? [{ id: 11, type: "ipv4", assigneeId: 1 }, { id: 12, type: "ipv4", assigneeId: 2 }],
    listSnapshots: async () => fixture.snapshots ?? [],
    pricing: async () => ({ backupPercent: 20, volumeMilliCentsPerGbMonth: 5720, imageMilliCentsPerGbMonth: 1430, primaryIpv4MonthlyCents: { fsn1: 50, nbg1: 50, hel1: 50 } }),
    metrics: async () => ({ step: 900, cpu: Array.from({ length: 96 }, (_, i) => 10 + (i % 7)), diskIops: Array.from({ length: 96 }, () => 3) }),
    async runAction() { const a = { id: next++, status: "running" as const, error: null }; actions.set(a.id, { ...a, status: "success" }); return a; },
    getAction: async (id) => actions.get(id) ?? { id, status: "error", error: "unknown action" },
  };
}
```

`index.ts`: `export * from "./http.js"; export * from "./hetzner.js"; export * from "./coolify-instance.js";` (the third line lands in Task 3 — add it then).

- [ ] **Step 5: Add an `eurCents` test** to the same file:

```ts
import { eurCents } from "./hetzner.js";
it("parses Hetzner decimal strings to cents exactly", () => {
  expect(eurCents("35.4900000000")).toBe(3549);
  expect(eurCents("0.5000000000")).toBe(50);
  expect(eurCents("5.4950000000")).toBe(550);
});
```

- [ ] **Step 6: Run** — `pnpm --filter @launchos/integrations test hetzner` → PASS.

- [ ] **Step 7: Commit** — `git add packages/integrations && git commit -m "feat(integrations): Hetzner Cloud client and mock"`

---

### Task 3: Coolify instance client

**Files:**
- Create: `packages/integrations/src/infra/coolify-instance.ts`
- Modify: `packages/integrations/src/infra/index.ts`
- Test: `packages/integrations/src/infra/coolify-instance.test.ts`

**Interfaces — Produces:**

```ts
export interface CoolifyResource { uuid: string; name: string; kind: "application" | "database" | "service"; state: string; health: string | null; fqdn: string | null }
export interface CoolifyInstanceClient {
  version(): Promise<string>;
  resources(): Promise<CoolifyResource[]>;
  deploy(appUuid: string): Promise<{ deploymentUuid: string | null }>;
}
export function coolifyInstanceClient(baseUrl: string, token: string, opts?: { fetch?: typeof fetch; timeoutMs?: number }): CoolifyInstanceClient; // "mock_" → mock
export function mockCoolifyInstanceClient(): CoolifyInstanceClient;
```

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { coolifyInstanceClient } from "./coolify-instance.js";

const route = (map: Record<string, unknown>) =>
  vi.fn(async (url: string) => {
    const path = new URL(url).pathname.replace("/api/v1", "");
    const body = map[path];
    return new Response(typeof body === "string" ? body : JSON.stringify(body ?? []), { status: body === undefined ? 404 : 200 });
  });

describe("coolifyInstanceClient", () => {
  it("reads version as text", async () => {
    const c = coolifyInstanceClient("http://1.2.3.4:8000", "7|abc", { fetch: route({ "/version": "4.3.23" }) as never });
    expect(await c.version()).toBe("4.3.23");
  });

  it("merges apps, databases and services and splits status into state/health", async () => {
    const f = route({
      "/applications": [{ uuid: "a1", name: "moodera-backend", status: "exited:unhealthy", fqdn: "https://x.test" }],
      "/databases": [{ uuid: "d1", name: "moodera-postgres", status: "running:healthy" }],
      "/services": [],
    });
    const rs = await coolifyInstanceClient("http://1.2.3.4:8000/", "t", { fetch: f as never }).resources();
    expect(rs).toEqual([
      { uuid: "a1", name: "moodera-backend", kind: "application", state: "exited", health: "unhealthy", fqdn: "https://x.test" },
      { uuid: "d1", name: "moodera-postgres", kind: "database", state: "running", health: "healthy", fqdn: null },
    ]);
  });

  it("deploys by uuid", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ deployments: [{ deployment_uuid: "dep1" }] })));
    const out = await coolifyInstanceClient("http://h:8000", "t", { fetch: f as never }).deploy("a1");
    expect(f.mock.calls[0]![0]).toBe("http://h:8000/api/v1/deploy?uuid=a1");
    expect(out.deploymentUuid).toBe("dep1");
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
import { infraRequest } from "./http.js";

export interface CoolifyResource { uuid: string; name: string; kind: "application" | "database" | "service"; state: string; health: string | null; fqdn: string | null }
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
  const req = (path: string, text = false) => infraRequest(root + path, { token, fetch: opts.fetch, timeoutMs: opts.timeoutMs ?? 5000, text });
  const list = async (path: string, kind: CoolifyResource["kind"]) =>
    ((await req(path)) as Raw[] ?? []).map((r): CoolifyResource => ({ uuid: r.uuid ?? "", name: r.name ?? "(unnamed)", kind, ...split(r.status), fqdn: r.fqdn ?? null }));
  return {
    version: async () => String(await req("/version", true)).trim(),
    resources: async () => (await Promise.all([list("/applications", "application"), list("/databases", "database"), list("/services", "service")])).flat(),
    async deploy(uuid) {
      const body = (await req(`/deploy?uuid=${encodeURIComponent(uuid)}`)) as { deployments?: { deployment_uuid?: string }[] } | null;
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
```

- [ ] **Step 4: Export** from `infra/index.ts`. **Run** tests → PASS.

- [ ] **Step 5: Commit** — `git add packages/integrations && git commit -m "feat(integrations): per-instance Coolify client"`

---

### Task 4: Cost maths (pure)

**Files:**
- Create: `packages/core/src/infrastructure/cost.ts`
- Test: `packages/core/src/infrastructure/cost.test.ts`

**Interfaces:**
- Consumes: `HetznerServer`, `HetznerVolume`, `HetznerPrimaryIp`, `HetznerImage`, `HetznerPricing` (Task 2); `ServerCost` (Task 1).
- Produces: `serverCost(input: { server; volumes; primaryIps; snapshots; pricing; now: Date }): ServerCost` and `monthStart(now: Date): Date`.

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { MOCK_SERVERS } from "@launchos/integrations";
import { serverCost } from "./cost.js";

const pricing = { backupPercent: 20, volumeMilliCentsPerGbMonth: 5720, imageMilliCentsPerGbMonth: 1430, primaryIpv4MonthlyCents: { fsn1: 50, nbg1: 50 } };
const cabio = MOCK_SERVERS[0]!; // cpx32 fsn1, €35.49, backups on, created May
const pizza = MOCK_SERVERS[1]!; // cx23 nbg1, €5.49, backups off, created 5 Sep

const at = (iso: string) => new Date(iso);

describe("serverCost", () => {
  it("caps the base at the monthly price once enough hours have run", () => {
    const c = serverCost({ server: cabio, volumes: [], primaryIps: [], snapshots: [], pricing, now: at("2026-09-30T23:00:00Z") });
    expect(c.base).toBe(3549);
  });

  it("prorates by the hour early in the month", () => {
    // 10 hours × 0.0569 €/h = 0.569 € → 57 cents
    const c = serverCost({ server: cabio, volumes: [], primaryIps: [], snapshots: [], pricing, now: at("2026-09-01T10:00:00Z") });
    expect(c.base).toBe(57);
  });

  it("counts from creation, not month start, for a server made this month", () => {
    // pizza created 5 Sep 00:00; at 6 Sep 00:00 → 24 h × 0.0088 = 0.2112 € → 21 cents
    const c = serverCost({ server: pizza, volumes: [], primaryIps: [], snapshots: [], pricing, now: at("2026-09-06T00:00:00Z") });
    expect(c.base).toBe(21);
  });

  it("adds backups at the percentage, volumes, primary IPv4 and snapshots on the projected month", () => {
    const c = serverCost({
      server: cabio,
      volumes: [{ id: 1, serverId: cabio.id, sizeGb: 100 }, { id: 2, serverId: 999, sizeGb: 50 }],
      primaryIps: [{ id: 1, type: "ipv4", assigneeId: cabio.id }, { id: 2, type: "ipv6", assigneeId: cabio.id }],
      snapshots: [{ id: 1, sizeGb: 10, createdFrom: cabio.id, description: "" }],
      pricing,
      now: at("2026-09-30T23:00:00Z"),
    });
    expect(c.backups).toBe(710);   // 20% of 3549, rounded
    expect(c.volumes).toBe(572);   // 100 GB × 0.0572
    expect(c.primaryIps).toBe(50); // ipv4 only
    expect(c.snapshots).toBe(14);  // 10 GB × 0.0143
    expect(c.projectedMonth).toBe(3549 + 710 + 572 + 50 + 14);
  });

  it("charges traffic only above the allowance", () => {
    const heavy = { ...pizza, outgoingTrafficBytes: pizza.includedTrafficBytes + 2 * 1024 ** 4 };
    expect(serverCost({ server: heavy, volumes: [], primaryIps: [], snapshots: [], pricing, now: at("2026-09-30T23:00:00Z") }).traffic).toBe(200);
    expect(serverCost({ server: pizza, volumes: [], primaryIps: [], snapshots: [], pricing, now: at("2026-09-30T23:00:00Z") }).traffic).toBe(0);
  });
});
```

- [ ] **Step 2: Run** — `pnpm --filter @launchos/core test infrastructure/cost` → FAIL.

- [ ] **Step 3: Implement**

```ts
import type { ServerCost } from "@launchos/db";
import type { HetznerImage, HetznerPricing, HetznerPrimaryIp, HetznerServer, HetznerVolume } from "@launchos/integrations";

const HOUR = 3_600_000;
const TIB = 1024 ** 4;

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * What one server costs this month, in EUR cents, net — Hetzner's list prices
 * applied the way Hetzner bills: hourly until the monthly cap. Add-ons are
 * monthly and prorated with the same fraction as the base, so month-to-date
 * and projected stay consistent.
 *
 * ponytail: list prices, not the invoice — Hetzner's API has no invoices.
 */
export function serverCost(input: {
  server: HetznerServer; volumes: HetznerVolume[]; primaryIps: HetznerPrimaryIp[]; snapshots: HetznerImage[];
  pricing: HetznerPricing; now: Date;
}): ServerCost {
  const { server, pricing, now } = input;
  const from = Math.max(monthStart(now).getTime(), server.createdAt.getTime());
  const hours = Math.max(0, Math.ceil((now.getTime() - from) / HOUR));
  const monthly = server.price.monthlyCents;
  const base = Math.min(Math.round((hours * server.price.hourlyMicroCents) / 1_000_000), monthly);
  const fraction = monthly === 0 ? 0 : base / monthly;

  const backups = server.backupsEnabled ? Math.round((monthly * pricing.backupPercent) / 100) : 0;
  const volumes = Math.round(input.volumes.filter((v) => v.serverId === server.id).reduce((a, v) => a + v.sizeGb * pricing.volumeMilliCentsPerGbMonth, 0) / 1000);
  const primaryIps = input.primaryIps.filter((p) => p.assigneeId === server.id && p.type === "ipv4").length * (pricing.primaryIpv4MonthlyCents[server.location] ?? 0);
  const snapshots = Math.round(input.snapshots.filter((s) => s.createdFrom === server.id).reduce((a, s) => a + s.sizeGb * pricing.imageMilliCentsPerGbMonth, 0) / 1000);
  const overBytes = Math.max(0, server.outgoingTrafficBytes - server.includedTrafficBytes);
  const traffic = Math.round((overBytes / TIB) * server.price.perTbTrafficCents);

  const addOns = backups + volumes + primaryIps + snapshots;
  return {
    base, backups, volumes, primaryIps, snapshots, traffic,
    monthToDate: base + Math.round(addOns * fraction) + traffic,
    projectedMonth: monthly + addOns + traffic,
  };
}
```

Snapshots whose source server is gone are costed by the sync (Task 6) on an account-level line, not here.

- [ ] **Step 4: Run** → PASS. If `cabio` early-month rounding differs by 1 cent, fix the test arithmetic, not the formula (hours are ceiled, as Hetzner bills started hours).

- [ ] **Step 5: Commit** — `git add packages/core/src/infrastructure && git commit -m "feat(core): server cost from Hetzner list prices"`

---

### Task 5: Connections (encrypted CRUD, test, import from .env)

**Files:**
- Create: `packages/core/src/infrastructure/connections.ts`, `packages/core/src/infrastructure/index.ts`
- Modify: `packages/core/src/index.ts` (add `export * from "./infrastructure/index.js";`)
- Test: `packages/core/src/infrastructure/connections.test.ts`

**Interfaces — Produces:**

```ts
export const ConnectionInput: z.ZodType; // { provider, label, baseUrl?, token, actorId }
export interface ConnectionRow { id: string; provider: "hetzner_cloud" | "coolify"; label: string; baseUrl: string | null; serverId: string | null; lastSyncedAt: Date | null; lastError: string | null }
export async function testConnection(input: { provider; baseUrl?: string | null; token: string }, deps?: InfraDeps): Promise<{ ok: true; detail: string } | { ok: false; message: string }>;
export async function createConnection(db, organisationId, input, deps?): Promise<ConnectionRow>;   // tests first; throws on failure
export async function updateConnection(db, organisationId, input: { id; label?; baseUrl?; token?; serverId?: string | null; actorId }, deps?): Promise<ConnectionRow>;
export async function removeConnection(db, organisationId, input: { id; actorId }): Promise<void>;
export async function listConnections(db, organisationId): Promise<ConnectionRow[]>;
export async function connectionSecret(db, organisationId, id, env?): Promise<string>;
export async function importConnectionsFromEnv(db, organisationId, env, actorId, deps?): Promise<{ added: string[]; skipped: string[]; failed: { label: string; message: string }[] }>;
export interface InfraDeps { hetzner?: (token: string) => HetznerClient; coolify?: (url: string, token: string) => CoolifyInstanceClient; env?: NodeJS.ProcessEnv }
```

- [ ] **Step 1: Failing tests**

```ts
import { randomBytes } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { connectionSecret, createConnection, importConnectionsFromEnv, listConnections, removeConnection } from "./connections.js";

const env = { SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const deps = { env };
async function makeOrg(db: Db) {
  const [org] = await db.insert(schema.organisations).values({ name: "LF", slug: `lf-${crypto.randomUUID()}` }).returning();
  return org!;
}

describe("connections", () => {
  it("stores the token encrypted and never returns it", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await createConnection(db, org.id, { provider: "hetzner_cloud", label: "Hetzner A", token: "mock_abc", actorId: "u1" }, deps);
      expect(JSON.stringify(row)).not.toContain("mock_abc");
      const [raw] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.id, row.id));
      expect(raw!.tokenEncrypted).not.toContain("mock_abc");
      expect(await connectionSecret(db, org.id, row.id, env)).toBe("mock_abc");
    });
  });

  it("refuses to save a token the provider rejects", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const rejecting = { ...deps, hetzner: () => ({ listServers: async () => { throw new Error("The provider refused the token (HTTP 401)."); } }) as never };
      await expect(createConnection(db, org.id, { provider: "hetzner_cloud", label: "Bad", token: "x", actorId: "u1" }, rejecting)).rejects.toThrow(/refused/);
      expect(await listConnections(db, org.id)).toHaveLength(0);
    });
  });

  it("requires a base URL for Coolify", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      await expect(createConnection(db, org.id, { provider: "coolify", label: "C", token: "mock_x", actorId: "u1" }, deps)).rejects.toThrow(/URL/);
    });
  });

  it("is scoped to its organisation", async () => {
    await withTestDb(async (db) => {
      const a = await makeOrg(db); const b = await makeOrg(db);
      const row = await createConnection(db, a.id, { provider: "hetzner_cloud", label: "A", token: "mock_a", actorId: "u1" }, deps);
      expect(await listConnections(db, b.id)).toHaveLength(0);
      await expect(connectionSecret(db, b.id, row.id, env)).rejects.toThrow();
      await removeConnection(db, b.id, { id: row.id, actorId: "u1" });
      expect(await listConnections(db, a.id)).toHaveLength(1);
    });
  });

  it("writes audit rows for create and remove, without the token", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const row = await createConnection(db, org.id, { provider: "hetzner_cloud", label: "A", token: "mock_secret", actorId: "u1" }, deps);
      await removeConnection(db, org.id, { id: row.id, actorId: "u1" });
      const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.targetId, row.id));
      expect(audits.map((a) => a.action).sort()).toEqual(["infra.connection.create", "infra.connection.remove"]);
      expect(JSON.stringify(audits)).not.toContain("mock_secret");
    });
  });

  it("imports Hetzner and Coolify tokens from env, splitting Coolify on the first | only", async () => {
    await withTestDb(async (db) => {
      const org = await makeOrg(db);
      const envFile = {
        ...env,
        HETZNER_API_TOKENS: "mock_h1,mock_h2",
        COOLIFY_CABIOMASTER: "http://10.9.0.1:8000|mock_7|abc",
        COOLIFY_EMPTY: "http://10.9.0.9:8000|",
      };
      const out = await importConnectionsFromEnv(db, org.id, envFile, "u1", { env });
      expect(out.added.sort()).toEqual(["Coolify — CABIOMASTER", "Hetzner — account 1", "Hetzner — account 2"]);
      expect(out.skipped).toEqual(["Coolify — EMPTY"]);
      const again = await importConnectionsFromEnv(db, org.id, envFile, "u1", { env });
      expect(again.added).toEqual([]); // label is unique; re-import is a no-op
    });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `connections.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { coolifyInstanceClient, hetznerClient, type CoolifyInstanceClient, type HetznerClient } from "@launchos/integrations";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { decryptSecret, encryptSecret, loadEncryptionKey } from "../secrets/encryption.js";

export interface InfraDeps {
  hetzner?: (token: string) => HetznerClient;
  coolify?: (url: string, token: string) => CoolifyInstanceClient;
  env?: NodeJS.ProcessEnv;
}
export const hetznerFor = (deps: InfraDeps, token: string) => (deps.hetzner ?? hetznerClient)(token);
export const coolifyFor = (deps: InfraDeps, url: string, token: string) => (deps.coolify ?? coolifyInstanceClient)(url, token);

export const ConnectionInput = z
  .object({
    provider: z.enum(["hetzner_cloud", "coolify"]),
    label: z.string().trim().min(1).max(80),
    baseUrl: z.string().trim().url().nullish(),
    token: z.string().trim().min(1).max(500),
    actorId: z.string().min(1),
  })
  .refine((v) => v.provider !== "coolify" || !!v.baseUrl, { message: "A Coolify connection needs its URL, e.g. http://1.2.3.4:8000", path: ["baseUrl"] });
export type ConnectionInput = z.input<typeof ConnectionInput>;

export interface ConnectionRow {
  id: string; provider: "hetzner_cloud" | "coolify"; label: string; baseUrl: string | null;
  serverId: string | null; lastSyncedAt: Date | null; lastError: string | null;
}
const PUBLIC = {
  id: schema.infraConnections.id, provider: schema.infraConnections.provider, label: schema.infraConnections.label,
  baseUrl: schema.infraConnections.baseUrl, serverId: schema.infraConnections.serverId,
  lastSyncedAt: schema.infraConnections.lastSyncedAt, lastError: schema.infraConnections.lastError,
};
const owned = (organisationId: string, id: string) =>
  and(eq(schema.infraConnections.organisationId, organisationId), eq(schema.infraConnections.id, id));

/** Calls the provider with the token. The only way a connection gets saved. */
export async function testConnection(
  input: { provider: "hetzner_cloud" | "coolify"; baseUrl?: string | null; token: string },
  deps: InfraDeps = {},
): Promise<{ ok: true; detail: string } | { ok: false; message: string }> {
  try {
    if (input.provider === "hetzner_cloud") {
      const servers = await hetznerFor(deps, input.token).listServers();
      return { ok: true, detail: `${servers.length} server${servers.length === 1 ? "" : "s"}` };
    }
    const version = await coolifyFor(deps, input.baseUrl ?? "", input.token).version();
    return { ok: true, detail: `Coolify ${version}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The provider could not be reached." };
  }
}

export async function createConnection(db: Db, organisationId: string, raw: ConnectionInput, deps: InfraDeps = {}): Promise<ConnectionRow> {
  const input = ConnectionInput.parse(raw);
  const key = loadEncryptionKey(deps.env); // no key, no write
  const test = await testConnection(input, deps);
  if (!test.ok) throw new Error(test.message);
  const [row] = await db.insert(schema.infraConnections).values({
    organisationId, provider: input.provider, label: input.label, baseUrl: input.baseUrl ?? null,
    tokenEncrypted: encryptSecret(input.token, key),
  }).returning(PUBLIC);
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: input.actorId, action: "infra.connection.create", targetType: "infra_connection", targetId: row!.id,
    after: { provider: input.provider, label: input.label, baseUrl: input.baseUrl ?? null },
  });
  return row!;
}

export const UpdateConnectionInput = z.object({
  id: z.string().uuid(), label: z.string().trim().min(1).max(80).optional(), baseUrl: z.string().trim().url().nullish(),
  token: z.string().trim().min(1).max(500).optional(), serverId: z.string().uuid().nullish(), actorId: z.string().min(1),
});

export async function updateConnection(db: Db, organisationId: string, raw: z.input<typeof UpdateConnectionInput>, deps: InfraDeps = {}): Promise<ConnectionRow> {
  const input = UpdateConnectionInput.parse(raw);
  const [before] = await db.select().from(schema.infraConnections).where(owned(organisationId, input.id));
  if (!before) throw new Error("Connection not found.");
  if (input.serverId) {
    const [srv] = await db.select({ id: schema.servers.id }).from(schema.servers)
      .where(and(eq(schema.servers.organisationId, organisationId), eq(schema.servers.id, input.serverId)));
    if (!srv) throw new Error("Server not found.");
  }
  let tokenEncrypted: string | undefined;
  if (input.token) {
    const baseUrl = input.baseUrl ?? before.baseUrl;
    const test = await testConnection({ provider: before.provider, baseUrl, token: input.token }, deps);
    if (!test.ok) throw new Error(test.message);
    tokenEncrypted = encryptSecret(input.token, loadEncryptionKey(deps.env));
  }
  const [row] = await db.update(schema.infraConnections).set({
    ...(input.label ? { label: input.label } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.serverId !== undefined ? { serverId: input.serverId } : {}),
    ...(tokenEncrypted ? { tokenEncrypted, lastError: null } : {}),
    updatedAt: new Date(),
  }).where(owned(organisationId, input.id)).returning(PUBLIC);
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: input.actorId, action: "infra.connection.update", targetType: "infra_connection", targetId: input.id,
    before: { label: before.label, baseUrl: before.baseUrl, serverId: before.serverId },
    after: { label: row!.label, baseUrl: row!.baseUrl, serverId: row!.serverId, tokenReplaced: !!tokenEncrypted },
  });
  return row!;
}

export async function removeConnection(db: Db, organisationId: string, input: { id: string; actorId: string }): Promise<void> {
  const [gone] = await db.delete(schema.infraConnections).where(owned(organisationId, input.id))
    .returning({ id: schema.infraConnections.id, label: schema.infraConnections.label, provider: schema.infraConnections.provider });
  if (!gone) return;
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: input.actorId, action: "infra.connection.remove", targetType: "infra_connection", targetId: gone.id,
    before: { label: gone.label, provider: gone.provider },
  });
}

export async function listConnections(db: Db, organisationId: string): Promise<ConnectionRow[]> {
  return db.select(PUBLIC).from(schema.infraConnections)
    .where(eq(schema.infraConnections.organisationId, organisationId))
    .orderBy(asc(schema.infraConnections.provider), asc(schema.infraConnections.label));
}

/** The only reader of plaintext. Server-side callers only. */
export async function connectionSecret(db: Db, organisationId: string, id: string, env?: NodeJS.ProcessEnv): Promise<string> {
  const [row] = await db.select({ t: schema.infraConnections.tokenEncrypted }).from(schema.infraConnections).where(owned(organisationId, id));
  if (!row) throw new Error("Connection not found.");
  return decryptSecret(row.t, loadEncryptionKey(env));
}

/**
 * One-off carrier: reads HETZNER_API_TOKENS (comma list, and every line of
 * that name when the caller passes a merged value) and COOLIFY_<NAME>=url|token.
 * Coolify tokens contain `|` themselves — split on the FIRST one only.
 * Labels are the dedupe key, so running it twice adds nothing.
 */
export async function importConnectionsFromEnv(
  db: Db, organisationId: string, source: Record<string, string | undefined>, actorId: string, deps: InfraDeps = {},
): Promise<{ added: string[]; skipped: string[]; failed: { label: string; message: string }[] }> {
  const existing = new Set((await listConnections(db, organisationId)).map((c) => c.label));
  const wanted: ConnectionInput[] = [];
  const skipped: string[] = [];

  (source.HETZNER_API_TOKENS ?? "").split(",").map((t) => t.trim()).filter(Boolean)
    .forEach((token, i) => wanted.push({ provider: "hetzner_cloud", label: `Hetzner — account ${i + 1}`, token, actorId }));

  for (const [key, value] of Object.entries(source)) {
    const m = /^COOLIFY_([A-Z0-9_]+)$/.exec(key);
    if (!m || !value || !value.includes("|") || !/^https?:\/\//.test(value)) continue;
    const cut = value.indexOf("|");
    const baseUrl = value.slice(0, cut).trim();
    const token = value.slice(cut + 1).trim();
    const label = `Coolify — ${m[1]}`;
    if (!token) { skipped.push(label); continue; }
    wanted.push({ provider: "coolify", label, baseUrl, token, actorId });
  }

  const added: string[] = [];
  const failed: { label: string; message: string }[] = [];
  for (const input of wanted) {
    if (existing.has(input.label)) continue;
    try { await createConnection(db, organisationId, input, deps); added.push(input.label); }
    catch (error) { failed.push({ label: input.label, message: error instanceof Error ? error.message : String(error) }); }
  }
  return { added, skipped, failed };
}
```

`index.ts`: `export * from "./connections.js"; export * from "./cost.js";` (Tasks 6 and 7 add `sync.js` and `actions.js`).

**The `.env` quirk:** Shoji's `.env` has two lines named `HETZNER_API_TOKENS`. `process.env` keeps only one. The web action in Task 8 therefore reads `.env` itself (`readFileSync` on the repo `.env`, local only), joins every `HETZNER_API_TOKENS=` line with commas, and passes that merged map. In production there is no `.env`; tokens are pasted in the form.

- [ ] **Step 4: Run** — `pnpm --filter @launchos/core test infrastructure/connections` → PASS.

- [ ] **Step 5: Commit** — `git add packages/core && git commit -m "feat(core): encrypted infrastructure connections"`

---

### Task 6: Sync

**Files:**
- Create: `packages/core/src/infrastructure/sync.ts`
- Test: `packages/core/src/infrastructure/sync.test.ts`

**Interfaces:**
- Consumes: `hetznerFor`, `coolifyFor`, `connectionSecret`, `InfraDeps` (Task 5); `serverCost` (Task 4).
- Produces: `syncInfrastructure(db, organisationId, deps: InfraDeps & { now?: Date }): Promise<{ servers: number; connections: { label: string; ok: boolean; error?: string }[] }>`

- [ ] **Step 1: Failing tests**

```ts
import { randomBytes } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { mockHetznerClient } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createConnection } from "./connections.js";
import { syncInfrastructure } from "./sync.js";

const env = { SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const now = new Date("2026-09-25T12:00:00Z");
async function org(db: Db) {
  const [o] = await db.insert(schema.organisations).values({ name: "LF", slug: `lf-${crypto.randomUUID()}` }).returning();
  return o!;
}

describe("syncInfrastructure", () => {
  it("upserts servers and one supplier_costs row per server", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      const out = await syncInfrastructure(db, o.id, { env, now });
      expect(out.servers).toBe(2);
      const costs = await db.select().from(schema.supplierCosts).where(and(eq(schema.supplierCosts.organisationId, o.id), eq(schema.supplierCosts.supplier, "hetzner")));
      expect(costs).toHaveLength(2);
      expect(costs[0]).toMatchObject({ source: "sync", currencyCode: "EUR", vatTreatment: "reverse_charge", billingPeriodUnit: "month", business: "shared" });
      const pizza = costs.find((c) => c.name.includes("mock-pizza"))!;
      expect(pizza.renewalPrice).toBe(549 + 572 + 50); // base + 100 GB volume + IPv4
      await syncInfrastructure(db, o.id, { env, now });
      expect(await db.select().from(schema.servers).where(eq(schema.servers.organisationId, o.id))).toHaveLength(2);
    });
  });

  it("never overwrites the business a person set, and copies it to the cost row", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      await db.update(schema.servers).set({ business: "cabio" }).where(eq(schema.servers.name, "mock-cabio"));
      await syncInfrastructure(db, o.id, { env, now });
      const [s] = await db.select().from(schema.servers).where(eq(schema.servers.name, "mock-cabio"));
      expect(s!.business).toBe("cabio");
      const [c] = await db.select().from(schema.supplierCosts).where(eq(schema.supplierCosts.externalId, `${s!.connectionId}:${s!.hetznerId}`));
      expect(c!.business).toBe("cabio");
    });
  });

  it("one failing connection does not stop the others and records its error", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      const good = await createConnection(db, o.id, { provider: "hetzner_cloud", label: "Good", token: "mock_1", actorId: "u" }, { env });
      const bad = await createConnection(db, o.id, { provider: "hetzner_cloud", label: "Bad", token: "mock_2", actorId: "u" }, { env });
      const hetzner = (token: string) => {
        if (token === "mock_2") return { ...mockHetznerClient(), listServers: async () => { throw new Error("boom"); } };
        return mockHetznerClient();
      };
      const out = await syncInfrastructure(db, o.id, { env, now, hetzner });
      expect(out.connections.find((c) => c.label === "Bad")).toMatchObject({ ok: false, error: "boom" });
      const [b] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.id, bad.id));
      const [g] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.id, good.id));
      expect(b!.lastError).toBe("boom");
      expect(g!.lastError).toBeNull();
      expect(g!.lastSyncedAt).not.toBeNull();
    });
  });

  it("links a Coolify connection to the server whose IPv4 is its URL host", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      const c = await createConnection(db, o.id, { provider: "coolify", label: "C", baseUrl: "http://10.9.0.2:8000", token: "mock_c", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      const [row] = await db.select().from(schema.infraConnections).where(eq(schema.infraConnections.id, c.id));
      const [pizza] = await db.select().from(schema.servers).where(eq(schema.servers.ipv4, "10.9.0.2"));
      expect(row!.serverId).toBe(pizza!.id);
    });
  });

  it("settles a pending action", async () => {
    await withTestDb(async (db) => {
      const o = await org(db);
      await createConnection(db, o.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
      await syncInfrastructure(db, o.id, { env, now });
      const client = mockHetznerClient();
      const a = await client.runAction(1, "reboot");
      await db.update(schema.servers).set({ pendingAction: { id: a.id, command: "reboot", startedAt: now.toISOString() } }).where(eq(schema.servers.hetznerId, 1));
      await syncInfrastructure(db, o.id, { env, now, hetzner: () => client });
      const [s] = await db.select().from(schema.servers).where(eq(schema.servers.hetznerId, 1));
      expect(s!.pendingAction).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `sync.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { HetznerClient } from "@launchos/integrations";
import { and, eq, isNull } from "drizzle-orm";
import { connectionSecret, hetznerFor, listConnections, type InfraDeps } from "./connections.js";
import { serverCost } from "./cost.js";

const DAY = 86_400_000;

/**
 * One pass over every connection. Each connection is its own try/catch: a
 * revoked token on one account must not blank the other nine servers.
 * Server rows are telemetry (exempt from audit_log, like uptime_checks); the
 * cost rows follow the Hostinger sync's rules.
 */
export async function syncInfrastructure(db: Db, organisationId: string, deps: InfraDeps & { now?: Date } = {}) {
  const now = deps.now ?? new Date();
  const connections = await listConnections(db, organisationId);
  const report: { label: string; ok: boolean; error?: string }[] = [];
  let serverCount = 0;

  for (const conn of connections.filter((c) => c.provider === "hetzner_cloud")) {
    try {
      const client = hetznerFor(deps, await connectionSecret(db, organisationId, conn.id, deps.env));
      serverCount += await syncHetznerAccount(db, organisationId, conn.id, conn.label, client, now);
      await markConnection(db, organisationId, conn.id, null, now);
      report.push({ label: conn.label, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markConnection(db, organisationId, conn.id, message, now);
      report.push({ label: conn.label, ok: false, error: message });
    }
  }

  await linkCoolifyByIp(db, organisationId, connections);
  return { servers: serverCount, connections: report };
}

async function syncHetznerAccount(db: Db, organisationId: string, connectionId: string, label: string, client: HetznerClient, now: Date) {
  const [list, volumes, primaryIps, snapshots, pricing] = await Promise.all([
    client.listServers(), client.listVolumes(), client.listPrimaryIps(), client.listSnapshots(), client.pricing(),
  ]);

  for (const server of list) {
    const cost = serverCost({ server, volumes, primaryIps, snapshots, pricing, now });
    const metrics = await client.metrics(server.id, new Date(now.getTime() - DAY), now)
      .then((m) => ({ from: new Date(now.getTime() - DAY).toISOString(), ...m }))
      .catch(() => null); // a metrics hiccup is not a sync failure

    const values = {
      name: server.name, serverType: server.serverType, location: server.location, ipv4: server.ipv4, status: server.status,
      deleteProtected: server.deleteProtected, backupsEnabled: server.backupsEnabled,
      includedTrafficBytes: server.includedTrafficBytes, outgoingTrafficBytes: server.outgoingTrafficBytes,
      cost, ...(metrics ? { metrics } : {}), hetznerCreatedAt: server.createdAt, seenAt: now, updatedAt: now,
    };
    const [row] = await db.insert(schema.servers)
      .values({ organisationId, connectionId, hetznerId: server.id, ...values })
      .onConflictDoUpdate({ target: [schema.servers.organisationId, schema.servers.connectionId, schema.servers.hetznerId], set: values })
      .returning();

    if (row!.pendingAction) {
      const action = await client.getAction(row!.pendingAction.id).catch(() => null);
      if (action && action.status !== "running") {
        await db.update(schema.servers).set({ pendingAction: null }).where(eq(schema.servers.id, row!.id));
      }
    }

    await upsertServerCost(db, organisationId, `${connectionId}:${server.id}`, `Hetzner — ${server.name} (${server.serverType.toUpperCase()})`, cost.projectedMonth, row!.business, label, now);
  }

  // Snapshots of servers that no longer exist still bill. One account-level line.
  const liveIds = new Set(list.map((s) => s.id));
  const orphanCents = Math.round(snapshots.filter((s) => s.createdFrom === null || !liveIds.has(s.createdFrom))
    .reduce((a, s) => a + s.sizeGb * pricing.imageMilliCentsPerGbMonth, 0) / 1000);
  if (orphanCents > 0) {
    await upsertServerCost(db, organisationId, `${connectionId}:orphan-snapshots`, `Hetzner — snapshots of deleted servers (${label})`, orphanCents, "shared", label, now);
  }
  return list.length;
}

async function upsertServerCost(db: Db, organisationId: string, externalId: string, name: string, cents: number, business: typeof schema.servers.$inferSelect["business"], account: string, now: Date) {
  const money = { name, status: "active", renewalPrice: cents, totalPrice: cents, currencyCode: "EUR", billingPeriod: 1, billingPeriodUnit: "month", business, seenAt: now, updatedAt: now };
  await db.insert(schema.supplierCosts)
    .values({ organisationId, supplier: "hetzner", source: "sync", externalId, vatTreatment: "reverse_charge", notes: `Synced from ${account}. List price, projected month.`, ...money })
    .onConflictDoUpdate({ target: [schema.supplierCosts.organisationId, schema.supplierCosts.supplier, schema.supplierCosts.externalId], set: money });
}

async function markConnection(db: Db, organisationId: string, id: string, error: string | null, now: Date) {
  await db.update(schema.infraConnections)
    .set(error ? { lastError: error.slice(0, 500) } : { lastError: null, lastSyncedAt: now })
    .where(and(eq(schema.infraConnections.organisationId, organisationId), eq(schema.infraConnections.id, id)));
}

/** A Coolify on port 8000 of a server's public IP is that server's Coolify. Only fills blanks; never overrides a person. */
async function linkCoolifyByIp(db: Db, organisationId: string, connections: Awaited<ReturnType<typeof listConnections>>) {
  for (const c of connections.filter((c) => c.provider === "coolify" && !c.serverId && c.baseUrl)) {
    let host: string;
    try { host = new URL(c.baseUrl!).hostname; } catch { continue; }
    const [srv] = await db.select({ id: schema.servers.id }).from(schema.servers)
      .where(and(eq(schema.servers.organisationId, organisationId), eq(schema.servers.ipv4, host)));
    if (srv) {
      await db.update(schema.infraConnections).set({ serverId: srv.id })
        .where(and(eq(schema.infraConnections.id, c.id), isNull(schema.infraConnections.serverId)));
    }
  }
}
```

Host-by-name (a Coolify behind a domain) is out of scope: all ten are `http://<ip>:8000` today, and the Settings screen lets Shoji pick the server by hand.

- [ ] **Step 4: Run** → PASS. Check the business-copy test: `upsertServerCost` sets `business` in `money`, so a later sync copies the person's tag onto the cost row.

- [ ] **Step 5: Add to barrel, typecheck, commit** — `git add packages/core && git commit -m "feat(core): sync Hetzner servers and their cost"`

---

### Task 7: Worker job

**Files:**
- Create: `apps/worker/src/jobs/infra-sync.ts`
- Modify: `packages/core/src/queue/queues.ts` (add `infraSync: "infra.sync"` beside `costsReconcile`), `apps/worker/src/index.ts` (work + schedule)
- Test: `apps/worker/src/jobs/infra-sync.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { handleInfraSync } from "./infra-sync.js";

describe("handleInfraSync", () => {
  it("logs a summary and never throws when a connection failed", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Console;
    const sync = vi.fn(async () => ({ servers: 3, connections: [{ label: "A", ok: true }, { label: "B", ok: false, error: "401" }] }));
    const out = await handleInfraSync({ db: {} as never, logger, sync }, { organisationId: "o1" });
    expect(out.servers).toBe(3);
    expect(logger.warn).toHaveBeenCalledWith("[infra.sync] connection failed", { organisationId: "o1", label: "B", error: "401" });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
import { syncInfrastructure } from "@launchos/core";
import type { Db } from "@launchos/db";

export interface InfraSyncDeps { db: Db; logger: Console; env?: NodeJS.ProcessEnv; sync?: typeof syncInfrastructure }

/** Every 15 minutes: Hetzner → servers + cost register. A failed connection is logged and shown on Settings, never thrown. */
export async function handleInfraSync(deps: InfraSyncDeps, job: { organisationId: string }) {
  const out = await (deps.sync ?? syncInfrastructure)(deps.db, job.organisationId, { env: deps.env });
  for (const c of out.connections.filter((c) => !c.ok)) {
    deps.logger.warn("[infra.sync] connection failed", { organisationId: job.organisationId, label: c.label, error: c.error });
  }
  deps.logger.info("[infra.sync] done", { organisationId: job.organisationId, servers: out.servers });
  return out;
}
```

In `apps/worker/src/index.ts`, next to the `costsReconcile` block:

```ts
  await boss.work(QUEUE.infraSync, async () => {
    await sweepOrganisations(db, "infra sync", async (organisationId) => {
      await handleInfraSync({ db, logger: console, env: process.env }, { organisationId });
    });
  });
```

and with the other schedules:

```ts
  await boss.schedule(QUEUE.infraSync, "*/15 * * * *", {}, { tz: "Europe/London" });
```

Check whether queues must also be created (search `createQueue` in `apps/worker/src/boss.ts`); if queues are listed there, add `QUEUE.infraSync` the same way.

- [ ] **Step 4: Run** — `pnpm --filter @launchos/worker test infra-sync` → PASS; `pnpm typecheck`.

- [ ] **Step 5: Commit** — `git add apps/worker packages/core/src/queue && git commit -m "feat(worker): sync infrastructure every 15 minutes"`

---

### Task 8: Settings → Infrastructure screen

**Files:**
- Create: `apps/web/src/app/(admin)/settings/infrastructure/page.tsx`, `actions.ts`, `connection-form.tsx`
- Modify: `apps/web/src/lib/nav.ts` (Automation group, after "API tokens": `{ label: "Infrastructure", href: "/settings/infrastructure", icon: Server, permission: "settings" }` — import `Server` from lucide-react)

Read `node_modules/next/dist/docs/` on server actions + `useActionState` before writing; mirror `settings/api-tokens` exactly (DataList, PageHeader, Section, StatCard).

- [ ] **Step 1: `actions.ts`**

```ts
"use server";

import { readFileSync } from "node:fs";
import path from "node:path";
import { createConnection, importConnectionsFromEnv, removeConnection, syncInfrastructure, testConnection, updateConnection } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

const PATH = "/settings/infrastructure";

async function requireOwner() {
  const session = await requireAdmin();
  if (session.role !== "owner") throw new Error("Only the owner can manage infrastructure.");
  return session;
}

export type ConnectionState = { status: "idle" } | { status: "error"; message: string } | { status: "saved"; label: string };

export async function saveConnectionAction(_prev: ConnectionState, form: FormData): Promise<ConnectionState> {
  const session = await requireOwner();
  const id = String(form.get("id") ?? "");
  const token = String(form.get("token") ?? "").trim();
  const label = String(form.get("label") ?? "").trim();
  const baseUrl = String(form.get("baseUrl") ?? "").trim() || null;
  const serverId = String(form.get("serverId") ?? "") || null;
  try {
    if (id) {
      await updateConnection(getDb(), session.organisationId, { id, label, baseUrl, serverId, ...(token ? { token } : {}), actorId: session.userId });
    } else {
      const provider = String(form.get("provider")) === "coolify" ? "coolify" : "hetzner_cloud";
      await createConnection(getDb(), session.organisationId, { provider, label, baseUrl, token, actorId: session.userId });
    }
    revalidatePath(PATH);
    return { status: "saved", label };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : "Could not save the connection." };
  }
}

export async function testConnectionAction(form: FormData) {
  await requireOwner();
  const provider = String(form.get("provider")) === "coolify" ? "coolify" : "hetzner_cloud";
  return testConnection({ provider, baseUrl: String(form.get("baseUrl") ?? "") || null, token: String(form.get("token") ?? "") });
}

export async function removeConnectionAction(form: FormData): Promise<void> {
  const session = await requireOwner();
  await removeConnection(getDb(), session.organisationId, { id: String(form.get("id")), actorId: session.userId });
  revalidatePath(PATH);
}

export async function syncNowAction(): Promise<void> {
  const session = await requireOwner();
  await syncInfrastructure(getDb(), session.organisationId);
  revalidatePath(PATH);
  revalidatePath("/servers");
}

/**
 * Local only: the repo `.env` holds the tokens as a carrier. Read the file
 * itself because `.env` has two `HETZNER_API_TOKENS` lines and process.env
 * keeps only one. Absent in production, so the button simply reports nothing.
 */
export async function importFromEnvAction(): Promise<{ added: string[]; skipped: string[]; failed: { label: string; message: string }[] }> {
  const session = await requireOwner();
  const file = [path.resolve(process.cwd(), ".env"), path.resolve(process.cwd(), "../../.env")].find((p) => { try { readFileSync(p); return true; } catch { return false; } });
  if (!file) return { added: [], skipped: [], failed: [{ label: ".env", message: "No .env file here — paste tokens into the form instead." }] };
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const source: Record<string, string> = {};
  const hetzner: string[] = [];
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq < 1 || line.trimStart().startsWith("#")) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key === "HETZNER_API_TOKENS") hetzner.push(value);
    else if (key.startsWith("COOLIFY_")) source[key] = value;
  }
  source.HETZNER_API_TOKENS = hetzner.join(",");
  const out = await importConnectionsFromEnv(getDb(), session.organisationId, source, session.userId);
  revalidatePath(PATH);
  return out;
}
```

`COOLIFY_API_URL`/`COOLIFY_API_TOKEN` are skipped automatically: their values don't match `http…|token`.

- [ ] **Step 2: `page.tsx`** — server component. `requireAdmin()`; if not owner render `EmptyState` "Owner only". Load `listConnections` and servers (`db.select({ id, name, ipv4 }).from(schema.servers)` via a small core helper `listServerOptions(db, orgId)` — add it to `connections.ts` with a one-line test). Render:
  - `PageHeader` title "Infrastructure", description "Hetzner accounts and Coolify instances LaunchOS reads from."
  - `StatCard`s: connections, failing (`lastError` set), last sync (latest `lastSyncedAt`).
  - `DataList` columns: Label, Provider (`Hetzner Cloud` / `Coolify`), URL (Coolify), Server (name via options map, or "not linked"), Last sync (`formatDateTime`), Status (`lastError` in destructive text, else "OK"), Edit/Remove (`<form action={removeConnectionAction}>` with hidden id and a confirm).
  - Buttons: "Sync now" (`<form action={syncNowAction}>`), "Import from .env" (client button calling `importFromEnvAction` and showing added/skipped/failed counts).
  - `<ConnectionForm servers={options} />`.

- [ ] **Step 3: `connection-form.tsx`** — `"use client"`, `useActionState(saveConnectionAction, { status: "idle" })`. Fields: provider select (Hetzner Cloud | Coolify), label, base URL (shown only for Coolify, placeholder `http://1.2.3.4:8000`), token (`type="password"`, `autoComplete="off"`), server select (Coolify only; "Match by IP automatically" as the empty option). A "Test" button calls `testConnectionAction(new FormData(form))` and shows `detail` or `message`. On `saved` reset the form. Never echo the token back.

- [ ] **Step 4: Verify in the browser** — stop anything on :3000, `pnpm dev`, sign in as owner, open `/settings/infrastructure`, click **Import from .env**. Expected: 2 Hetzner + 10 Coolify added, 0 failed. Click **Sync now**. Expected: all rows "OK", 10 Coolify rows each showing a linked server. Screenshot for Shoji.

- [ ] **Step 5: Commit** — `git add apps/web && git commit -m "feat(settings): infrastructure connections"`

---

### Task 9: Server and app actions (core)

**Files:**
- Create: `packages/core/src/infrastructure/actions.ts`
- Test: `packages/core/src/infrastructure/actions.test.ts`

**Interfaces — Produces:**

```ts
export const SERVER_COMMANDS = ["reboot", "shutdown", "poweron", "create_image", "enable_backup", "disable_backup"] as const;
export async function runServerAction(db, organisationId, input: { serverId: string; command: ServerCommand; confirmName?: string; actorId: string }, deps?: InfraDeps & { now?: Date }): Promise<{ actionId: number }>;
export async function setServerBusiness(db, organisationId, input: { serverId: string; business: CostBusiness; actorId: string }): Promise<void>;
export async function redeployApp(db, organisationId, input: { connectionId: string; appUuid: string; appName: string; actorId: string }, deps?: InfraDeps): Promise<{ deploymentUuid: string | null }>;
export interface ServerView { /* servers row + connection label + coolify connection id/label/baseUrl */ }
export async function listServers(db, organisationId): Promise<ServerView[]>;
export async function coolifyResourcesFor(db, organisationId, connectionId, deps?): Promise<{ ok: true; resources: CoolifyResource[] } | { ok: false; message: string }>;
```

- [ ] **Step 1: Failing tests**

```ts
import { randomBytes } from "node:crypto";
import { schema, type Db } from "@launchos/db";
import { withTestDb } from "@launchos/db/test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createConnection } from "./connections.js";
import { redeployApp, runServerAction, setServerBusiness } from "./actions.js";
import { syncInfrastructure } from "./sync.js";

const env = { SECRETS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
async function seeded(db: Db) {
  const [o] = await db.insert(schema.organisations).values({ name: "LF", slug: `lf-${crypto.randomUUID()}` }).returning();
  await createConnection(db, o!.id, { provider: "hetzner_cloud", label: "H", token: "mock_1", actorId: "u" }, { env });
  await syncInfrastructure(db, o!.id, { env });
  const [s] = await db.select().from(schema.servers).where(eq(schema.servers.name, "mock-pizza"));
  return { org: o!, server: s! };
}

describe("runServerAction", () => {
  it("requires the typed server name for reboot and shutdown", async () => {
    await withTestDb(async (db) => {
      const { org, server } = await seeded(db);
      await expect(runServerAction(db, org.id, { serverId: server.id, command: "reboot", confirmName: "wrong", actorId: "u" }, { env })).rejects.toThrow(/name/);
    });
  });

  it("runs, stores the pending action and audits it", async () => {
    await withTestDb(async (db) => {
      const { org, server } = await seeded(db);
      const out = await runServerAction(db, org.id, { serverId: server.id, command: "reboot", confirmName: "mock-pizza", actorId: "u" }, { env });
      const [after] = await db.select().from(schema.servers).where(eq(schema.servers.id, server.id));
      expect(after!.pendingAction).toMatchObject({ id: out.actionId, command: "reboot" });
      const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "infra.server.reboot"));
      expect(audit).toMatchObject({ targetType: "server", targetId: server.id, actorId: "u" });
    });
  });

  it("refuses a second action while one is running", async () => {
    await withTestDb(async (db) => {
      const { org, server } = await seeded(db);
      await runServerAction(db, org.id, { serverId: server.id, command: "poweron", actorId: "u" }, { env });
      await expect(runServerAction(db, org.id, { serverId: server.id, command: "poweron", actorId: "u" }, { env })).rejects.toThrow(/already/);
    });
  });

  it("cannot touch another organisation's server", async () => {
    await withTestDb(async (db) => {
      const { server } = await seeded(db);
      const [other] = await db.insert(schema.organisations).values({ name: "X", slug: `x-${crypto.randomUUID()}` }).returning();
      await expect(runServerAction(db, other!.id, { serverId: server.id, command: "poweron", actorId: "u" }, { env })).rejects.toThrow(/not found/);
    });
  });
});

describe("setServerBusiness", () => {
  it("tags the server, the cost row follows, and it is audited", async () => {
    await withTestDb(async (db) => {
      const { org, server } = await seeded(db);
      await setServerBusiness(db, org.id, { serverId: server.id, business: "launchflow", actorId: "u" });
      const [c] = await db.select().from(schema.supplierCosts).where(eq(schema.supplierCosts.externalId, `${server.connectionId}:${server.hetznerId}`));
      expect(c!.business).toBe("launchflow");
      const [a] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "infra.server.business"));
      expect(a!.before).toEqual({ business: "shared" });
    });
  });
});

describe("redeployApp", () => {
  it("deploys through the connection and audits it", async () => {
    await withTestDb(async (db) => {
      const { org } = await seeded(db);
      const c = await createConnection(db, org.id, { provider: "coolify", label: "C", baseUrl: "http://10.9.0.2:8000", token: "mock_c", actorId: "u" }, { env });
      const out = await redeployApp(db, org.id, { connectionId: c.id, appUuid: "mock-app", appName: "mock-web", actorId: "u" }, { env });
      expect(out.deploymentUuid).toBe("mock-deployment");
      const [a] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "infra.app.redeploy"));
      expect(a!.after).toMatchObject({ appUuid: "mock-app", appName: "mock-web" });
    });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `actions.ts`**

```ts
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { CoolifyResource } from "@launchos/integrations";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { COST_BUSINESSES, type CostBusiness } from "../costs/register.js";
import { connectionSecret, coolifyFor, hetznerFor, type InfraDeps } from "./connections.js";

export const SERVER_COMMANDS = ["reboot", "shutdown", "poweron", "create_image", "enable_backup", "disable_backup"] as const;
export type ServerCommand = (typeof SERVER_COMMANDS)[number];
/** These take a running site offline; the person types the server's name to confirm. */
const NAMED = new Set<ServerCommand>(["reboot", "shutdown"]);

const RunInput = z.object({ serverId: z.string().uuid(), command: z.enum(SERVER_COMMANDS), confirmName: z.string().optional(), actorId: z.string().min(1) });

async function ownedServer(db: Db, organisationId: string, serverId: string) {
  const [s] = await db.select().from(schema.servers).where(and(eq(schema.servers.organisationId, organisationId), eq(schema.servers.id, serverId)));
  if (!s) throw new Error("Server not found.");
  return s;
}

export async function runServerAction(db: Db, organisationId: string, raw: z.input<typeof RunInput>, deps: InfraDeps & { now?: Date } = {}) {
  const input = RunInput.parse(raw);
  const server = await ownedServer(db, organisationId, input.serverId);
  if (NAMED.has(input.command) && input.confirmName?.trim() !== server.name) throw new Error(`Type the server name "${server.name}" to confirm.`);
  if (server.pendingAction) throw new Error(`${server.name} already has a ${server.pendingAction.command} in progress — wait for it to finish.`);

  const now = deps.now ?? new Date();
  const client = hetznerFor(deps, await connectionSecret(db, organisationId, server.connectionId, deps.env));
  const description = input.command === "create_image" ? `LaunchOS ${now.toISOString().slice(0, 16)}` : undefined;
  const action = await client.runAction(server.hetznerId, input.command, description);

  await db.update(schema.servers)
    .set({ pendingAction: { id: action.id, command: input.command, startedAt: now.toISOString() }, updatedAt: now })
    .where(eq(schema.servers.id, server.id));
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: input.actorId, action: `infra.server.${input.command}`, targetType: "server", targetId: server.id,
    after: { name: server.name, hetznerId: server.hetznerId, hetznerActionId: action.id },
  });
  return { actionId: action.id };
}

export async function setServerBusiness(db: Db, organisationId: string, input: { serverId: string; business: CostBusiness; actorId: string }) {
  const business = z.enum(COST_BUSINESSES).parse(input.business);
  const server = await ownedServer(db, organisationId, input.serverId);
  if (server.business === business) return;
  await db.update(schema.servers).set({ business, updatedAt: new Date() }).where(eq(schema.servers.id, server.id));
  await db.update(schema.supplierCosts).set({ business })
    .where(and(eq(schema.supplierCosts.organisationId, organisationId), eq(schema.supplierCosts.supplier, "hetzner"),
      eq(schema.supplierCosts.externalId, `${server.connectionId}:${server.hetznerId}`)));
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: input.actorId, action: "infra.server.business", targetType: "server", targetId: server.id,
    before: { business: server.business }, after: { business },
  });
}

export async function redeployApp(db: Db, organisationId: string, input: { connectionId: string; appUuid: string; appName: string; actorId: string }, deps: InfraDeps = {}) {
  const [conn] = await db.select().from(schema.infraConnections)
    .where(and(eq(schema.infraConnections.organisationId, organisationId), eq(schema.infraConnections.id, input.connectionId), eq(schema.infraConnections.provider, "coolify")));
  if (!conn?.baseUrl) throw new Error("Coolify connection not found.");
  const out = await coolifyFor(deps, conn.baseUrl, await connectionSecret(db, organisationId, conn.id, deps.env)).deploy(input.appUuid);
  await recordAudit(db, organisationId, {
    actorKind: "user", actorId: input.actorId, action: "infra.app.redeploy", targetType: "infra_connection", targetId: conn.id,
    after: { appUuid: input.appUuid, appName: input.appName, deploymentUuid: out.deploymentUuid },
  });
  return out;
}

export type ServerView = typeof schema.servers.$inferSelect & {
  accountLabel: string;
  coolify: { id: string; label: string; baseUrl: string } | null;
};

export async function listServers(db: Db, organisationId: string): Promise<ServerView[]> {
  const [rows, conns] = await Promise.all([
    db.select().from(schema.servers).where(eq(schema.servers.organisationId, organisationId)).orderBy(asc(schema.servers.name)),
    db.select().from(schema.infraConnections).where(eq(schema.infraConnections.organisationId, organisationId)),
  ]);
  const byId = new Map(conns.map((c) => [c.id, c]));
  return rows.map((s) => {
    const cf = conns.find((c) => c.provider === "coolify" && c.serverId === s.id && c.baseUrl);
    return { ...s, accountLabel: byId.get(s.connectionId)?.label ?? "?", coolify: cf ? { id: cf.id, label: cf.label, baseUrl: cf.baseUrl! } : null };
  });
}

/** Live, per page load, 5 s budget each. Failure is a value, not a throw — one dead Coolify must not break the screen. */
export async function coolifyResourcesFor(db: Db, organisationId: string, connectionId: string, deps: InfraDeps = {}):
  Promise<{ ok: true; resources: CoolifyResource[] } | { ok: false; message: string }> {
  try {
    const [conn] = await db.select().from(schema.infraConnections)
      .where(and(eq(schema.infraConnections.organisationId, organisationId), eq(schema.infraConnections.id, connectionId)));
    if (!conn?.baseUrl) return { ok: false, message: "not linked" };
    return { ok: true, resources: await coolifyFor(deps, conn.baseUrl, await connectionSecret(db, organisationId, conn.id, deps.env)).resources() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "unreachable" };
  }
}
```

- [ ] **Step 4: Run** → PASS. Export from the barrel. `pnpm typecheck`.

- [ ] **Step 5: Commit** — `git add packages/core && git commit -m "feat(core): server actions, business tag and app redeploy"`

---

### Task 10: Servers screen

**Files:**
- Create: `apps/web/src/app/(admin)/servers/page.tsx`, `actions.ts`, `server-actions-menu.tsx`, `business-select.tsx`, `sparkline.tsx`
- Modify: `apps/web/src/lib/nav.ts` (Delivery group, after Domains: `{ label: "Servers", href: "/servers", icon: Server, permission: "settings" }`)

Load the `launchflow-design` skill before writing JSX. Full-bleed table, white/light, no "AI slop".

- [ ] **Step 1: `actions.ts`**

```ts
"use server";

import { redeployApp, runServerAction, setServerBusiness, type ServerCommand } from "@launchos/core";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

async function requireOwner() {
  const s = await requireAdmin();
  if (s.role !== "owner") throw new Error("Only the owner can act on servers.");
  return s;
}
export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export async function serverAction(serverId: string, command: ServerCommand, confirmName?: string): Promise<ActionResult> {
  const s = await requireOwner();
  try {
    await runServerAction(getDb(), s.organisationId, { serverId, command, confirmName, actorId: s.userId });
    revalidatePath("/servers");
    return { ok: true, message: "Sent to Hetzner." };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Failed." }; }
}

export async function businessAction(serverId: string, business: string): Promise<ActionResult> {
  const s = await requireOwner();
  try {
    await setServerBusiness(getDb(), s.organisationId, { serverId, business: business as never, actorId: s.userId });
    revalidatePath("/servers"); revalidatePath("/profit");
    return { ok: true, message: "Saved." };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Failed." }; }
}

export async function redeployAction(connectionId: string, appUuid: string, appName: string): Promise<ActionResult> {
  const s = await requireOwner();
  try {
    await redeployApp(getDb(), s.organisationId, { connectionId, appUuid, appName, actorId: s.userId });
    return { ok: true, message: `Redeploy of ${appName} started.` };
  } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "Failed." }; }
}
```

- [ ] **Step 2: `page.tsx`** (server component, `export const dynamic = "force-dynamic"`)
  - Owner gate as in Task 8.
  - `const servers = await listServers(db, orgId)`; `const apps = await Promise.all(servers.map((s) => s.coolify ? coolifyResourcesFor(db, orgId, s.coolify.id) : Promise.resolve(null)))` — parallel, each already time-boxed.
  - `const rates = await ratesForCurrencies(db, orgId, ["EUR"])`; `const eurToGbp = rates.EUR ?? null` (micros). £ = `Math.round(cents * eurToGbp / 1_000_000)`. If null, show € only and a notice "No EUR→GBP rate — add one on Costs".
  - KPI strip (`StatCard`): Month to date, Projected month, Servers (`n running / total`), Needs attention (count of: status ≠ running, `pendingAction`, account `lastError`, Coolify unreachable, any resource with `state !== "running"`, traffic > 80%, `!backupsEnabled`).
  - Table grouped by `accountLabel` (a heading row per account). Columns: Server (name, `serverType` upper, location, lock icon if `deleteProtected`, "Backups off" badge if not `backupsEnabled`), Status (dot + text; "Rebooting…" from `pendingAction`), Business (`<BusinessSelect>`), CPU 24h (`<Sparkline values={metrics?.cpu} />`), Traffic (bar `outgoing/included`), Month to date, Projected (both £ with € beneath), Apps (each resource: dot green running/healthy, amber unknown, red otherwise; name links to `coolify.baseUrl`; applications get a small Redeploy button inside `<ServerActionsMenu>` confirm), Actions (`<ServerActionsMenu>`).
  - Row `<details>` expands the cost breakdown: Base, Backups, Volumes, IPv4, Snapshots, Traffic.
  - `seenAt` older than 1 h → status "Not seen since …" (server deleted in Hetzner).

- [ ] **Step 3: `sparkline.tsx`** — a pure server-renderable SVG, no chart lib:

```tsx
export function Sparkline({ values, max = 100 }: { values?: number[] | null; max?: number }) {
  if (!values?.length) return <span className="text-muted-foreground text-meta">—</span>;
  const w = 96, h = 24, top = Math.max(max, ...values);
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${h - (v / top) * h}`).join(" ");
  const last = values.at(-1)!;
  return (
    <span className="inline-flex items-center gap-2" title={`CPU last 24h, now ${last}%`}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary" /></svg>
      <span className="text-meta tabular-nums">{last}%</span>
    </span>
  );
}
```

- [ ] **Step 4: `server-actions-menu.tsx`** — `"use client"`. A dropdown (shadcn `DropdownMenu`) with Reboot, Shut down, Power on, Take snapshot, Backups on/off (whichever applies). Each opens a shadcn `AlertDialog`:
  - Reboot / Shut down: text input; confirm disabled until it equals the server name; passes `confirmName`.
  - Snapshot: "Costs about €{(sizeGb × 0.0143).toFixed(2)}/month while kept" — use `primary_disk` unknown, so say "€0.0143 per GB per month while kept".
  - Backups on: "+20% — about €{(monthlyCents × 0.2 / 100).toFixed(2)}/month".
  - Calls `serverAction`, shows the result with the existing toast (`grep -r "toast" apps/web/src/components` to find it).
  - Disabled with "Busy" when `pendingAction` is set.
  - Separate `RedeployButton({ connectionId, appUuid, appName })` with a plain confirm calling `redeployAction`.

- [ ] **Step 5: `business-select.tsx`** — `"use client"` `<select>` over `COST_BUSINESSES` with `BUSINESS_LABELS`, `onChange` → `businessAction`, optimistic value, revert + toast on error. (Client components cannot import `@launchos/core` — see memory "Client components can't import core": pass `options: { value, label }[]` from the page as a prop.)

- [ ] **Step 6: Verify in the browser** — `/servers` with the real connections (imported in Task 8). Expected: 10 servers across 2 accounts, projected total ≈ €145.33 (± a few cents of rounding), CABIOMASTER lock icon, six "Backups off" badges, moodera-backend shown red on LaunchFlowECOM, every other server's apps listed. **Do not click Reboot/Shut down on real servers.** Test actions only against a `mock_` connection. Screenshot for Shoji.

- [ ] **Step 7: Build check** — stop `pnpm dev`, run `pnpm --filter @launchos/web build`. Expected: success. Restart dev.

- [ ] **Step 8: Commit** — `git add apps/web && git commit -m "feat(servers): every server, its apps and what it costs"`

---

### Task 11: Register duplicate flag + e2e

**Files:**
- Modify: the cost register screen under `apps/web/src/app/(admin)/settings/costs/` (find the row rendering with `grep -n "source" apps/web/src/app/(admin)/settings/costs/*.tsx`)
- Create: `apps/web/tests/e2e/servers.spec.ts`

- [ ] **Step 1: Duplicate hint** — when the register has ≥1 synced `hetzner` row, render manual `hetzner` rows with a note: "Now synced per server — this hand-typed line probably double-counts. Delete it if so." No automatic deletion. Synced hetzner rows show "Set on Servers" in place of the business editor.

- [ ] **Step 2: e2e** — follow the sign-in helper used by `apps/web/tests/e2e/client-access.spec.ts`.

```ts
import { expect, test } from "@playwright/test";
// import the owner sign-in helper exactly as client-access.spec.ts does

test("owner adds a mock Hetzner connection, sees servers, reboots one", async ({ page }) => {
  // await signInAsOwner(page);
  await page.goto("/settings/infrastructure");
  await page.getByLabel("Provider").selectOption("hetzner_cloud");
  await page.getByLabel("Label").fill(`E2E Hetzner ${Date.now()}`);
  await page.getByLabel("Token").fill("mock_e2e");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Sync now" }).click();
  await page.goto("/servers");
  await expect(page.getByText("mock-pizza").first()).toBeVisible();
  const row = page.getByRole("row", { name: /mock-pizza/ }).first();
  await row.getByRole("button", { name: "Actions" }).click();
  await page.getByRole("menuitem", { name: "Reboot" }).click();
  await page.getByLabel("Type the server name").fill("mock-pizza");
  await page.getByRole("button", { name: "Reboot" }).click();
  await expect(row.getByText(/Rebooting/)).toBeVisible();
});
```

- [ ] **Step 3: Run** — `pnpm --filter @launchos/web exec playwright test servers` → PASS. Then full `pnpm test` and `pnpm typecheck`.

- [ ] **Step 4: Commit** — `git add apps/web && git commit -m "feat(costs): flag the hand-typed Hetzner line; e2e for servers"`

- [ ] **Step 5: Report to Shoji** — screenshots of both screens, test counts, the €/£ totals, and a clear "not pushed". Update memory `hetzner-servers-and-coolify.md` with "built, not pushed" and the commit range.
