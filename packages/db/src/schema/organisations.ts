import { jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Defined in its own file (rather than in system.ts) so that _shared.ts can
// import `organisations` without creating an import cycle with system.ts,
// which itself imports the shared column helpers.
export const organisationStatusEnum = pgEnum("organisation_status", ["active", "suspended"]);

export const organisations = pgTable("organisations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: organisationStatusEnum("status").default("active").notNull(),
  // Supplier identity as it must appear on an invoice. HMRC requires the
  // supplier's name, address and VAT registration number on a VAT invoice, so
  // these are what the printable invoice renders opposite the "Billed to"
  // block. All nullable: an organisation is created before anyone has typed
  // its registration details in, and a business below the threshold has no
  // VAT number at all — an empty `vatNumber` is what makes the invoice print
  // "VAT not registered" instead of a rate it is not entitled to charge.
  legalName: text("legal_name"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  postcode: text("postcode"),
  country: text("country"),
  vatNumber: text("vat_number"),
  companyNumber: text("company_number"),
  /** Free text printed at the foot of every invoice: bank details, terms, a thank-you. */
  invoiceFooter: text("invoice_footer"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
});
