import { boolean, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";

export const sitePlatformEnum = pgEnum("site_platform", ["wordpress", "static", "nextjs", "other"]);
export const hostingProviderEnum = pgEnum("hosting_provider", ["coolify", "other"]);
export const siteStatusEnum = pgEnum("site_status", ["live", "building", "paused", "archived"]);
export const domainStatusEnum = pgEnum("domain_status", ["active", "expiring", "expired", "transferring"]);
export const dnsTypeEnum = pgEnum("dns_type", ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]);

export const sites = pgTable("sites", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  primaryUrl: text("primary_url").notNull(),
  platform: sitePlatformEnum("platform").default("wordpress").notNull(),
  hostingProvider: hostingProviderEnum("hosting_provider").default("coolify").notNull(),
  hostingRef: text("hosting_ref"),
  status: siteStatusEnum("status").default("live").notNull(),
});

export const domains = pgTable("domains", {
  ...tenantColumns(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  registrar: text("registrar"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  autoRenew: boolean("auto_renew").default(true).notNull(),
  status: domainStatusEnum("status").default("active").notNull(),
}, (t) => [uniqueIndex("domains_org_name").on(t.organisationId, t.name)]);

export const dnsRecords = pgTable("dns_records", {
  ...tenantColumns(),
  domainId: uuid("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  type: dnsTypeEnum("type").notNull(),
  name: text("name").notNull(),
  value: text("value").notNull(),
  ttl: integer("ttl").default(3600).notNull(),
  proxied: boolean("proxied").default(false).notNull(),
});
