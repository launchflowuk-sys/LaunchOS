import { index, integer, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";
import { sites } from "./sites.js";

/**
 * What an entry in the client's access vault is for. Grouped this way on the
 * Access tab: dashboards, servers (`server` and `ssh`), databases, DNS and
 * registrar, hosting panels, email, other.
 */
export const clientAccessKindEnum = pgEnum("client_access_kind", [
  "dashboard",
  "server",
  "ssh",
  "database",
  "dns",
  "registrar",
  "hosting_panel",
  "email",
  "other",
]);

/**
 * One way into something we look after for a client — a website dashboard, a
 * Hetzner box, a database, the registrar — with its address, its username and,
 * where there is one, its password.
 *
 * The password is stored as an AES-256-GCM envelope produced by
 * `packages/core/src/secrets`, exactly like `site_credentials`: the column
 * holds ciphertext only, nothing in this repository writes the plaintext to a
 * log, an audit row or a seed, and the list endpoint never returns it — only
 * whether one is held. Reading it back is a deliberate act (`revealAccessSecret`)
 * that is audited and stamped on the row, so every look at a password says who
 * and when.
 *
 * `notes` is plain text on purpose: it is for "the MySQL user is read-only" and
 * "port 2222, not 22", not for a second password. The form says so.
 */
export const clientAccessEntries = pgTable(
  "client_access_entries",
  {
    ...tenantColumns(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    /** The website this access belongs to, when it belongs to one. Survives the site being deleted. */
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    kind: clientAccessKindEnum("kind").notNull(),
    label: text("label").notNull(),
    url: text("url"),
    host: text("host"),
    port: integer("port"),
    username: text("username"),
    secretCiphertext: text("secret_ciphertext"),
    notes: text("notes"),
    sort: integer("sort").default(0).notNull(),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
    /** The staff user who last revealed the secret. Text, matching `audit_log.actor_id`. */
    lastViewedBy: text("last_viewed_by"),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
  },
  (t) => [index("client_access_entries_org_client").on(t.organisationId, t.clientId)],
);
