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
