import { index, integer, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";

/**
 * Every PDF this business hands a client, from one engine and one table.
 *
 * A proposal, a delivery report, an invoice and a monthly account report are
 * the same object as far as storage goes: bytes on disk, a human reference
 * printed in the footer, and a rule about who may read them. Keeping them in
 * one table is what makes "everything the client keeps looks like the same
 * company" enforceable rather than aspirational — the chrome lives in
 * `packages/channels/src/pdf/document.ts` and every kind below wears it.
 *
 * Two things are deliberately *not* here:
 *
 * - **No public route.** `content_assets` are served by uuid alone because
 *   Facebook and WordPress fetch them with no cookie. A document is a priced
 *   proposal or an invoice; it is read through a signed, expiring link or a
 *   session, never by id alone. `packages/core/src/documents/document-link.ts`
 *   holds that rule.
 * - **No owning foreign key.** `subject_type`/`subject_id` is a loose pair
 *   rather than a column per document kind, because the subject tables land
 *   one release at a time (proposals in P3b, delivery reports and invoices in
 *   P5) and a nullable FK per kind would mean a migration for each. The link
 *   that matters in the other direction — `proposals.document_id` — is a real
 *   FK on the owning row, added by the release that needs it.
 */
export const documentKindEnum = pgEnum("document_kind", [
  "proposal",
  "proposal_signed",
  "delivery_report",
  "invoice",
  "monthly_report",
  "other",
]);
export type DocumentKind = (typeof documentKindEnum.enumValues)[number];

export const documents = pgTable("documents", {
  ...tenantColumns(),
  /**
   * Null while the document belongs to a lead rather than a client — a
   * proposal is written before anyone becomes a client, which is the whole
   * point of it. `on delete set null` for the same reason a merged client
   * must not take its signed paperwork with it.
   */
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  kind: documentKindEnum("kind").notNull(),
  /** What the reader sees at the top: "Proposal — website and care plan". */
  title: text("title").notNull(),
  /** The human handle printed in the footer and quoted on the phone: `P-2026-014`. */
  reference: text("reference").notNull(),
  /** Relative to `STORAGE_DIR`, POSIX separators — `documents/<org>/<uuid>.pdf`. */
  path: text("path").notNull(),
  mime: text("mime").default("application/pdf").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  /**
   * SHA-256 of the bytes as stored.
   *
   * A proposal that has been accepted is evidence: the client clicked a button
   * that said they agreed to *this* document. The digest is what lets us say a
   * year later that the file on disk is still the file they signed, and it
   * costs one hash at write time.
   */
  sha256: text("sha256").notNull(),
  /** `proposal`, `invoice`, `client_report` … — the table `subject_id` names. */
  subjectType: text("subject_type"),
  subjectId: uuid("subject_id"),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
}, (t) => [
  index("documents_org_client").on(t.organisationId, t.clientId),
  index("documents_org_subject").on(t.organisationId, t.subjectType, t.subjectId),
]);
