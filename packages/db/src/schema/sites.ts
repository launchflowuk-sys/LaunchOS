import { boolean, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";

export const sitePlatformEnum = pgEnum("site_platform", ["wordpress", "static", "nextjs", "other"]);
export const hostingProviderEnum = pgEnum("hosting_provider", ["coolify", "other"]);
export const siteStatusEnum = pgEnum("site_status", ["live", "building", "paused", "archived"]);
export const domainStatusEnum = pgEnum("domain_status", ["active", "expiring", "expired", "transferring"]);
export const dnsTypeEnum = pgEnum("dns_type", ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]);
export const dnsProviderEnum = pgEnum("dns_provider", ["cloudflare", "registrar", "other", "hostinger"]);

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

export const domains = pgTable(
  "domains",
  {
    ...tenantColumns(),
    // A domain is bought for a client and may exist long before its site.
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    registrar: text("registrar"),
    dnsProvider: dnsProviderEnum("dns_provider").default("other").notNull(),
    nameservers: text("nameservers").array().$type<string[]>().default([]).notNull(),
    notes: text("notes"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    autoRenew: boolean("auto_renew").default(true).notNull(),
    status: domainStatusEnum("status").default("active").notNull(),
  },
  (t) => [uniqueIndex("domains_org_name").on(t.organisationId, t.name)],
);

export const dnsRecords = pgTable("dns_records", {
  ...tenantColumns(),
  domainId: uuid("domain_id").notNull().references(() => domains.id, { onDelete: "cascade" }),
  type: dnsTypeEnum("type").notNull(),
  name: text("name").notNull(),
  value: text("value").notNull(),
  ttl: integer("ttl").default(3600).notNull(),
  proxied: boolean("proxied").default(false).notNull(),
});

export const siteCredentialKindEnum = pgEnum("site_credential_kind", ["wordpress_app_password"]);

/**
 * A per-site secret for an outward system we manage on the client's behalf —
 * today only a WordPress application password.
 *
 * Per site, never per organisation: each client's WordPress is a separate
 * install with its own user, and one shared credential would either not exist
 * or be a master key to every site we touch. The secret is stored as an
 * AES-256-GCM envelope produced by `packages/core/src/secrets`; the column
 * holds ciphertext only, and nothing in this repository ever writes the
 * plaintext to a log, an audit row or a seed.
 */
export const siteCredentials = pgTable(
  "site_credentials",
  {
    ...tenantColumns(),
    siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
    kind: siteCredentialKindEnum("kind").notNull(),
    username: text("username").notNull(),
    secretCiphertext: text("secret_ciphertext").notNull(),
    /** The staff user who last set it. Text, matching `audit_log.actor_id`. */
    createdBy: text("created_by"),
  },
  // One credential of each kind per site: setting it again replaces it, so a
  // rotated application password cannot leave the superseded one behind.
  (t) => [uniqueIndex("site_credentials_site_kind").on(t.siteId, t.kind)],
);
