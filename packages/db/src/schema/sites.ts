import { boolean, customType, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

/** Raw bytes. Drizzle has no `bytea` column, and `node-postgres` hands one back as a Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * The most recent thumbnail of each site, and what happened last time we tried.
 *
 * **Telemetry, not a business record.** It is refreshed on a schedule, nobody
 * edits it, and losing the table costs a set of pictures — so it is exempt from
 * `audit_log` the way `uptime_checks` is, and lives in its own table rather
 * than as columns on `sites` precisely so that a daily refresh cannot look like
 * somebody editing a client's website record twenty times a week.
 *
 * **The bytes live in Postgres.** A thumbnail is tens of kilobytes and there is
 * one per site, so the whole set is a megabyte or two — small enough that
 * putting it in the database buys a great deal: it is in the backup, it needs
 * no volume mounted into the worker *and* the web app, and it cannot fill a
 * disk. That last one is not hypothetical on this infrastructure.
 * `MAX_SCREENSHOT_BYTES` is what keeps the assumption true.
 *
 * One row per site: a capture replaces the last one. There is no history
 * because nothing asks for one, and a year of daily screenshots per site is
 * the version of this table that does fill a disk.
 */
export const siteScreenshots = pgTable(
  "site_screenshots",
  {
    ...tenantColumns(),
    siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
    /** Null when every attempt so far has failed — the row still records why. */
    bytes: bytea("bytes"),
    mime: text("mime"),
    width: integer("width"),
    height: integer("height"),
    sizeBytes: integer("size_bytes").default(0).notNull(),
    /** Which adapter produced it, so the UI can say "placeholder" honestly. */
    adapter: text("adapter").notNull(),
    /** When the bytes above were taken. Null while only failures have happened. */
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    /** When it was last tried, successfully or not. Drives "which is stalest". */
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).defaultNow().notNull(),
    /** A sentence, not a stack: shown under the empty thumbnail slot. */
    failureReason: text("failure_reason"),
  },
  (t) => [uniqueIndex("site_screenshots_site").on(t.siteId)],
);
