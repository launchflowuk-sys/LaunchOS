import { pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { organisationStatusEnum, organisations } from "./organisations.js";

// Re-exported so `schema.organisations` / `schema.organisationStatusEnum`
// keep resolving from system.ts as before, even though the table itself now
// lives in organisations.ts (see _shared.ts for why).
export { organisationStatusEnum, organisations };

export const memberRoleEnum = pgEnum("member_role", ["owner", "staff"]);
export const memberStatusEnum = pgEnum("member_status", ["active", "invited", "suspended"]);
export const clientUserRoleEnum = pgEnum("client_user_role", ["client_admin", "client_member"]);

export const organisationMembers = pgTable("organisation_members", {
  ...tenantColumns(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: memberRoleEnum("role").default("staff").notNull(),
  status: memberStatusEnum("status").default("active").notNull(),
}, (t) => [uniqueIndex("organisation_members_org_user").on(t.organisationId, t.userId)]);

export const clientUsers = pgTable("client_users", {
  ...tenantColumns(),
  // No FK to clients.id here: Plan 2 adds it once the clients/system import
  // order is settled. Keeping it a plain uuid avoids a circular import today.
  clientId: uuid("client_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: clientUserRoleEnum("role").default("client_member").notNull(),
}, (t) => [uniqueIndex("client_users_client_user").on(t.clientId, t.userId)]);
