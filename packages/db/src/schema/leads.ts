import { index, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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

/**
 * Numbers an inbound message must never turn into a lead.
 *
 * A message channel Shoji advertises will also carry his family, his drivers
 * and his existing clients. Everything downstream of a lead is machinery —
 * the Lead Qualifier drafts a sales reply, the owner's bell rings, the lead
 * sits on the board — and none of that should ever start because his wife
 * texted. This is the list that stops it, checked before anything is written.
 *
 * `phone` holds the number in E.164 (`+447700900123`), normalised on the way
 * in, so `07700 900123` and `+44 7700 900123` are the same row and cannot both
 * be added. Unique per organisation.
 */
export const leadSuppressions = pgTable("lead_suppressions", {
  ...tenantColumns(),
  phone: text("phone").notNull(),
  /** Why it is on the list, for whoever reads it in six months. */
  note: text("note"),
  addedByUserId: text("added_by_user_id"),
}, (t) => [
  uniqueIndex("lead_suppressions_org_phone").on(t.organisationId, t.phone),
]);
