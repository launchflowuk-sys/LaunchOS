import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";
import { documents } from "./documents.js";
import { projects } from "./projects.js";

/**
 * The record of a client signing off a finished build — the delivery report's
 * half of the one acceptance mechanism.
 *
 * **This table mirrors `proposal_acceptances` column for column on purpose**,
 * and the code behind it shares every rule rather than restating one: the same
 * SVG-path-only signature grammar, the same evidence set (name, email, moment,
 * IP, user agent), the same unique index doing the idempotency, and the same
 * countersigned-document-is-a-second-document rule. The pair of them is one
 * mechanism seen twice, not two mechanisms.
 *
 * It is a second table rather than a generalised `acceptances` because both
 * subjects exist today and each deserves a real foreign key. `documents` took
 * the loose `subject_type`/`subject_id` pair for the opposite reason — its
 * subject tables land one release at a time — and paying that price here would
 * mean dropping two enforced references, plus rewriting rows of signed
 * evidence in a migration, which is the last data in the system anyone should
 * be rewriting.
 *
 * `document_id` is the report as it stood when they signed it, so the file we
 * can produce a year later is the file they agreed to.
 */
export const deliverySignOffs = pgTable("delivery_sign_offs", {
  ...tenantColumns(),
  projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  signedName: text("signed_name").notNull(),
  signedEmail: text("signed_email").notNull(),
  signedAt: timestamp("signed_at", { withTimezone: true }).defaultNow().notNull(),
  /** As seen by the app, from the proxy headers the web route trusts. */
  ip: text("ip"),
  userAgent: text("user_agent"),
  /** The drawn signature as an SVG path. Sanitised by `core` before it is stored. */
  signatureSvg: text("signature_svg"),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
}, (t) => [
  // One sign-off per project, enforced here rather than by a read-then-insert:
  // a client on a phone double-taps Sign off, and the second insert has to
  // lose to something. This is that something.
  uniqueIndex("delivery_sign_offs_project").on(t.projectId),
  index("delivery_sign_offs_org").on(t.organisationId),
]);
