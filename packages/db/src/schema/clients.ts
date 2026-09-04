import { boolean, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";

export const clientStatusEnum = pgEnum("client_status", ["active", "paused", "archived"]);

export const clients = pgTable(
  "clients",
  {
    ...tenantColumns(),
    name: text("name").notNull(),
    // Used for the support address and portal URLs. Unique per organisation so
    // two organisations can both own a client called "acme".
    slug: text("slug").notNull(),
    tradingName: text("trading_name"),
    email: text("email"),
    phone: text("phone"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    postcode: text("postcode"),
    country: text("country").default("GB").notNull(),
    websiteUrl: text("website_url"),
    industry: text("industry"),
    // "<slug>@<SUPPORT_EMAIL_DOMAIN>". Globally unique: inbound mail is routed
    // by address alone, so two organisations must never share one.
    supportEmail: text("support_email"),
    // Plain uuid today; Plan 3 adds the FK to packages once that table exists.
    packageId: uuid("package_id"),
    status: clientStatusEnum("status").default("active").notNull(),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("clients_org_slug").on(t.organisationId, t.slug),
    uniqueIndex("clients_support_email").on(t.supportEmail),
  ],
);

export const clientContacts = pgTable("client_contacts", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  role: text("role"),
  isPrimary: boolean("is_primary").default(false).notNull(),
});
