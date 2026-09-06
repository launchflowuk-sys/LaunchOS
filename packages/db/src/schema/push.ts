import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";

/**
 * One browser's Web Push registration for one staff user. The endpoint is the
 * push service's URL for that browser profile, unique across the whole
 * database: a device re-subscribing under a different account moves the row
 * rather than doubling it. `p256dh` and `auth` are the client keys the
 * `web-push` library encrypts each payload with. `failed_at` is stamped when
 * the push service refuses a send; a 404/410 removes the row outright.
 */
export const pushSubscriptions = pgTable("push_subscriptions", {
  ...tenantColumns(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("push_subscriptions_endpoint").on(t.endpoint),
  index("push_subscriptions_org_user").on(t.organisationId, t.userId),
]);
