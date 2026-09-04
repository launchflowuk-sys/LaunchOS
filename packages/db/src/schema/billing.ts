import { integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";

// The entire "financial details" surface. No card numbers, no bank details:
// money movement is Stripe's job (Plan 5), and only its customer id lands here.
export const billingProfiles = pgTable(
  "billing_profiles",
  {
    ...tenantColumns(),
    clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    billingName: text("billing_name"),
    addressLine1: text("address_line1"),
    addressLine2: text("address_line2"),
    city: text("city"),
    postcode: text("postcode"),
    country: text("country").default("GB").notNull(),
    vatNumber: text("vat_number"),
    paymentTermsDays: integer("payment_terms_days").default(14).notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    preferredMethod: text("preferred_method"),
    notes: text("notes"),
  },
  (t) => [uniqueIndex("billing_profiles_client").on(t.clientId)],
);
