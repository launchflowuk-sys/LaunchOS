import { boolean, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";

/**
 * The work we do for a client beyond their website, each switched on by a
 * person and never by a payment.
 *
 * The website is not in the list because it is not optional: a client with no
 * website is not a client. Everything here spends money to do — model calls,
 * provider calls, somebody's hours — so what the Stripe package says a client
 * pays for is advice, not an instruction. Paying for ads and having ads
 * switched off is a warning on the screen; having ads switched on is the only
 * thing that makes the ingest, the Sentinel and the recurring ad tasks run.
 *
 * No row means off. That is the default for every client, new and existing.
 */
export const clientServiceEnum = pgEnum("client_service", ["ads", "blog", "social", "gbp"]);
export type ClientService = (typeof clientServiceEnum.enumValues)[number];

export const clientServices = pgTable("client_services", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  service: clientServiceEnum("service").notNull(),
  active: boolean("active").default(false).notNull(),
  /** When the switch last moved, and who moved it. The history is in `audit_log`. */
  changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
  changedByUserId: text("changed_by_user_id").references(() => user.id, { onDelete: "set null" }),
}, (t) => [uniqueIndex("client_services_org_client_service").on(t.organisationId, t.clientId, t.service)]);
