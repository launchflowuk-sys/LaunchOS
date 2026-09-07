import { index, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";

export const leadStatusEnum = pgEnum("lead_status", ["new", "contacted", "qualified", "converted", "lost"]);
export type LeadStatus = (typeof leadStatusEnum.enumValues)[number];

/**
 * New business coming in: a form on launchflow.co.uk, a self-serve signup
 * that started Checkout, a note Shoji typed after a phone call. `source` is
 * free text so a new form never needs a migration. `client_id` is set by
 * `convertLeadToClient` (and by `completeSignup`), and `metadata` carries
 * whatever the source knew — the Checkout session id, the page the form was
 * on, UTM tags.
 */
export const leads = pgTable("leads", {
  ...tenantColumns(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  business: text("business"),
  message: text("message"),
  source: text("source").default("manual").notNull(),
  status: leadStatusEnum("status").default("new").notNull(),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
}, (t) => [
  index("leads_org_status_created").on(t.organisationId, t.status, t.createdAt),
]);
