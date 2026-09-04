import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";
import { organisationStatusEnum, organisations } from "./organisations.js";

// Re-exported so `schema.organisations` / `schema.organisationStatusEnum`
// keep resolving from system.ts as before, even though the table itself now
// lives in organisations.ts (see _shared.ts for why).
export { organisationStatusEnum, organisations };

export const memberRoleEnum = pgEnum("member_role", ["owner", "staff"]);
export const memberStatusEnum = pgEnum("member_status", ["active", "invited", "suspended"]);
export const clientUserRoleEnum = pgEnum("client_user_role", ["client_admin", "client_member"]);
// Portal access has to be revocable without deleting the `user` row, which
// would cascade away the audit trail's actor. `organisation_members` already
// carries the same idea for staff.
export const clientUserStatusEnum = pgEnum("client_user_status", ["active", "suspended"]);

export const organisationMembers = pgTable("organisation_members", {
  ...tenantColumns(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  title: text("title"),
  phone: text("phone"),
  invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
  initialPasswordSetAt: timestamp("initial_password_set_at", { withTimezone: true }),
  role: memberRoleEnum("role").default("staff").notNull(),
  status: memberStatusEnum("status").default("active").notNull(),
}, (t) => [uniqueIndex("organisation_members_org_user").on(t.organisationId, t.userId)]);

export const clientUsers = pgTable("client_users", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: clientUserRoleEnum("role").default("client_member").notNull(),
  status: clientUserStatusEnum("status").default("active").notNull(),
}, (t) => [uniqueIndex("client_users_client_user").on(t.clientId, t.userId)]);
