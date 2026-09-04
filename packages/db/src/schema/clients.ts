import { boolean, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";

export const clientStatusEnum = pgEnum("client_status", ["active", "paused", "archived"]);

export const clients = pgTable("clients", {
  ...tenantColumns(),
  name: text("name").notNull(),
  tradingName: text("trading_name"),
  email: text("email"),
  phone: text("phone"),
  status: clientStatusEnum("status").default("active").notNull(),
  notes: text("notes"),
});

export const clientContacts = pgTable("client_contacts", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  role: text("role"),
  isPrimary: boolean("is_primary").default(false).notNull(),
});
