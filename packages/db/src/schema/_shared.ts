import { jsonb, timestamp, uuid } from "drizzle-orm/pg-core";
import { organisations } from "./organisations.js";

export const id = () => uuid("id").defaultRandom().primaryKey();
export const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
export const updatedAt = () => timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();
export const deletedAt = () => timestamp("deleted_at", { withTimezone: true });
export const metadata = () => jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull();
export const organisationId = () =>
  uuid("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" });
export const baseColumns = () => ({ id: id(), createdAt: createdAt(), updatedAt: updatedAt(), deletedAt: deletedAt(), metadata: metadata() });
export const tenantColumns = () => ({ ...baseColumns(), organisationId: organisationId() });
