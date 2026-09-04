import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";
import { sites } from "./sites.js";
import { actorKindEnum } from "./support.js";

// The per-client timeline. Append-only narrative for humans; audit_log stays
// the machine record of who changed which field.
export const activityEvents = pgTable(
  "activity_events",
  {
    ...tenantColumns(),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    actorKind: actorKindEnum("actor_kind").notNull(),
    actorId: text("actor_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
  },
  (t) => [index("activity_events_client_time").on(t.clientId, t.createdAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    ...tenantColumns(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("notifications_user_unread").on(t.userId, t.readAt)],
);
