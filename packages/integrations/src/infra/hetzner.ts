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
  id: z.number(),
  name: z.string(),
  status: z.string(),
  created: z.string(),
  server_type: z.object({
    name: z.string(),
    prices: z.array(
      z.object({
        location: z.string(),
        price_hourly: Money,
        price_monthly: Money,
        included_traffic: z.number(),
        price_per_tb_traffic: Money,
      }),
    ),
  }),
  location: z.object({ name: z.string() }),
  public_net: z.object({ ipv4: z.object({ ip: z.string() }).nullable() }),
  protection: z.object({ delete: z.boolean() }),
  backup_window: z.string().nullable(),
  included_traffic: z.number().nullable(),
  outgoing_traffic: z.number().nullable(),
});

export interface HetznerServer {
  id: number;
  name: string;
  status: string;
  createdAt: Date;
  serverType: string;
  location: string;
  ipv4: string | null;
  deleteProtected: boolean;
  backupsEnabled: boolean;
  includedTrafficBytes: number;
  outgoingTrafficBytes: number;
  price: { hourlyMicroCents: number; monthlyCents: number; perTbTrafficCents: number };
}
export interface HetznerVolume {
  id: number;
  serverId: number | null;
  sizeGb: number;
}
export interface HetznerPrimaryIp {
  id: number;
  type: "ipv4" | "ipv6";
  assigneeId: number | null;
}
export interface HetznerImage {
  id: number;
  sizeGb: number;
  createdFrom: number | null;
  description: string;
}
export interface HetznerPricing {
  backupPercent: number;
  imageMilliCentsPerGbMonth: number;
  volumeMilliCentsPerGbMonth: number;
  primaryIpv4MonthlyCents: Record<string, number>; // by location
}
export type HetznerCommand = "reboot" | "shutdown" | "poweron" | "create_image" | "enable_backup" | "disable_backup";
export interface HetznerAction {
  id: number;
  status: "running" | "success" | "error";
  error: string | null;
}

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
    id: s.id,
    name: s.name,
    status: s.status,
    createdAt: new Date(s.created),
    serverType: s.server_type.name,
    location: s.location.name,
    ipv4: s.public_net.ipv4?.ip ?? null,
    deleteProtected: s.protection.delete,
    backupsEnabled: s.backup_window !== null,
    includedTrafficBytes: s.included_traffic ?? p.included_traffic,
    outgoingTrafficBytes: s.outgoing_traffic ?? 0,
    price: {
      hourlyMicroCents: microCents(p.price_hourly.net),
      monthlyCents: eurCents(p.price_monthly.net),
      perTbTrafficCents: eurCents(p.price_per_tb_traffic.net),
    },
  };
}

const milli = (v: string) => Math.round(Number(v) * 100 * 1000);

export function hetznerClient(token: string, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): HetznerClient {
  if (token.startsWith("mock_")) return mockHetznerClient();
  const get = (path: string) => infraRequest(API + path, { token, fetch: opts.fetch, timeoutMs: opts.timeoutMs });
  const post = (path: string, body?: unknown) =>
    infraRequest(API + path, { method: "POST", token, body: body ?? {}, fetch: opts.fetch, timeoutMs: opts.timeoutMs });

  async function paged<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const body = (await get(`${path}${sep}per_page=50&page=${page}`)) as Record<string, unknown> & {
        meta?: { pagination?: { next_page: number | null } };
      };
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
    listVolumes: async () =>
      (await paged<{ id: number; server: number | null; size: number }>("/volumes", "volumes")).map((v) => ({
        id: v.id,
        serverId: v.server,
        sizeGb: v.size,
      })),
    listPrimaryIps: async () =>
      (await paged<{ id: number; type: "ipv4" | "ipv6"; assignee_id: number | null }>("/primary_ips", "primary_ips")).map((p) => ({
        id: p.id,
        type: p.type,
        assigneeId: p.assignee_id,
      })),
    listSnapshots: async () =>
      (
        await paged<{ id: number; image_size: number | null; created_from: { id: number } | null; description: string }>(
          "/images?type=snapshot",
          "images",
        )
      ).map((i) => ({ id: i.id, sizeGb: i.image_size ?? 0, createdFrom: i.created_from?.id ?? null, description: i.description })),
    async pricing() {
      const { pricing: p } = (await get("/pricing")) as {
        pricing: {
          server_backup: { percentage: string };
          volume: { price_per_gb_month: { net: string } };
          image: { price_per_gb_month: { net: string } };
          primary_ips: { type: string; prices: { location: string; price_monthly: { net: string } }[] }[];
        };
      };
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
      const body = (await get(`/servers/${serverId}/metrics?${q}`)) as {
        metrics: { time_series: Record<string, { values: [number, string][] }> };
      };
      const ts = body.metrics.time_series;
      const series = (k: string) => (ts[k]?.values ?? []).map(([, v]) => Math.round(Number(v) * 10) / 10);
      const read = series("disk.0.iops.read");
      const write = series("disk.0.iops.write");
      return { step, cpu: series("cpu"), diskIops: read.map((r, i) => Math.round((r + (write[i] ?? 0)) * 10) / 10) };
    },
    runAction: async (serverId, command, description) =>
      action(await post(`/servers/${serverId}/actions/${command}`, command === "create_image" ? { type: "snapshot", description } : undefined)),
    getAction: async (id) => action(await get(`/actions/${id}`)),
  };
}

export interface MockHetznerFixture {
  servers?: HetznerServer[];
  volumes?: HetznerVolume[];
  primaryIps?: HetznerPrimaryIp[];
  snapshots?: HetznerImage[];
}

export const MOCK_SERVERS: HetznerServer[] = [
  {
    id: 1,
    name: "mock-cabio",
    status: "running",
    createdAt: new Date("2026-05-01T00:00:00Z"),
    serverType: "cpx32",
    location: "fsn1",
    ipv4: "10.9.0.1",
    deleteProtected: true,
    backupsEnabled: true,
    includedTrafficBytes: 21990232555520,
    outgoingTrafficBytes: 6_800_000_000,
    price: { hourlyMicroCents: 5_690_000, monthlyCents: 3549, perTbTrafficCents: 100 },
  },
  {
    id: 2,
    name: "mock-pizza",
    status: "running",
    createdAt: new Date("2026-09-05T00:00:00Z"),
    serverType: "cx23",
    location: "nbg1",
    ipv4: "10.9.0.2",
    deleteProtected: false,
    backupsEnabled: false,
    includedTrafficBytes: 21990232555520,
    outgoingTrafficBytes: 2_800_000_000,
    price: { hourlyMicroCents: 880_000, monthlyCents: 549, perTbTrafficCents: 100 },
  },
];

export function mockHetznerClient(fixture: MockHetznerFixture = {}): HetznerClient {
  const actions = new Map<number, HetznerAction>();
  let next = 1000;
  return {
    listServers: async () => fixture.servers ?? MOCK_SERVERS,
    listVolumes: async () => fixture.volumes ?? [{ id: 7, serverId: 2, sizeGb: 100 }],
    listPrimaryIps: async () => fixture.primaryIps ?? [{ id: 11, type: "ipv4", assigneeId: 1 }, { id: 12, type: "ipv4", assigneeId: 2 }],
    listSnapshots: async () => fixture.snapshots ?? [],
    pricing: async () => ({
      backupPercent: 20,
      volumeMilliCentsPerGbMonth: 5720,
      imageMilliCentsPerGbMonth: 1430,
      primaryIpv4MonthlyCents: { fsn1: 50, nbg1: 50, hel1: 50 },
    }),
    metrics: async () => ({
      step: 900,
      cpu: Array.from({ length: 96 }, (_, i) => 10 + (i % 7)),
      diskIops: Array.from({ length: 96 }, () => 3),
    }),
    async runAction() {
      const a = { id: next++, status: "running" as const, error: null };
      actions.set(a.id, { ...a, status: "success" });
      return a;
    },
    getAction: async (id) => actions.get(id) ?? { id, status: "error", error: "unknown action" },
  };
}
