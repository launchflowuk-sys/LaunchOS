import { pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { clients } from "./clients.js";

/** One support address per client: `<clients.slug>@<SUPPORT_EMAIL_DOMAIN>`. */
export const emailIdentities = pgTable("email_identities", {
  ...tenantColumns(),
  clientId: uuid("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  address: text("address").notNull(),
  displayName: text("display_name"),
  // Per-identity secret so a provider can be configured to sign one client's
  // forwards without sharing INBOUND_EMAIL_SECRET across every client.
  inboundSecret: text("inbound_secret").notNull(),
}, (t) => [
  uniqueIndex("email_identities_client").on(t.clientId),
  uniqueIndex("email_identities_address").on(t.address),
]);
