import { check, date, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantColumns } from "./_shared.js";
import { user } from "./auth.js";
import { clients } from "./clients.js";
import { documents } from "./documents.js";
import { leads } from "./leads.js";
import { packages } from "./packages.js";

export const proposalStatusEnum = pgEnum("proposal_status", [
  "draft",
  "sent",
  "viewed",
  "accepted",
  "declined",
  "expired",
]);
export type ProposalStatus = (typeof proposalStatusEnum.enumValues)[number];

/** The statuses a client may still act on: the two a live public page shows. */
export const PROPOSAL_LIVE_STATUSES: readonly ProposalStatus[] = ["sent", "viewed"];
/** The statuses a decision has already been recorded against. Terminal. */
export const PROPOSAL_DECIDED_STATUSES: readonly ProposalStatus[] = ["accepted", "declined"];

/**
 * The three ways LaunchFlow sells, and the only three.
 *
 * They are not presentation. Everything downstream reads `shape` and branches
 * on it: the totals the client is shown, the Stripe Checkout that opens on
 * acceptance, and the project that gets created afterwards. So the shape is a
 * closed set on the row rather than something inferred from which amounts
 * happen to be non-zero — "monthly is £250 and setup is £0" and "monthly is
 * £250, no setup fee was ever offered" are the same numbers and different
 * promises.
 *
 * - `monthly_on_delivery` — the default. Nothing is paid up front; the first
 *   month starts when the work goes live.
 * - `setup_plus_monthly` — a build fee on acceptance, then the retainer.
 * - `one_off` — a single price, no recurring anything.
 */
export const proposalPricingShapeEnum = pgEnum("proposal_pricing_shape", [
  "monthly_on_delivery",
  "setup_plus_monthly",
  "one_off",
]);
export type ProposalPricingShape = (typeof proposalPricingShapeEnum.enumValues)[number];
export const PROPOSAL_PRICING_SHAPES = proposalPricingShapeEnum.enumValues;

/**
 * What a priced line is: the build fee, the retainer, or a single charge.
 *
 * Which kinds a proposal may carry is decided entirely by its shape — a
 * `one_off` with a `monthly` line is refused when the line is added, not
 * discovered when somebody reads the total. `packages/core/src/proposals/
 * pricing.ts` holds that table and is the only place it is written down.
 */
export const proposalLineKindEnum = pgEnum("proposal_line_kind", ["setup", "monthly", "one_off"]);
export type ProposalLineKind = (typeof proposalLineKindEnum.enumValues)[number];

/** What is being delivered, what is not, and roughly when. */
export interface ProposalScope {
  deliverables: string[];
  outOfScope: string[];
  timeline: string;
}

export const PROPOSAL_SCOPE_DEFAULT: ProposalScope = { deliverables: [], outOfScope: [], timeline: "" };

/**
 * The headline price, in pence, alongside the shape that explains it.
 *
 * The three amounts are **derived**, never typed in: they are the sums of the
 * proposal's lines of each kind, rewritten by `core` on every line change.
 * The spec had them optional; making them required-and-zero removes the state
 * where a proposal has a £250 monthly line and a null `monthlyPence`, which is
 * the sort of disagreement that only shows up on a client's screen.
 *
 * `packageId` records which retainer the price came from, so a proposal that
 * is accepted can put the client on it without anybody re-deciding.
 */
export interface ProposalPricing {
  shape: ProposalPricingShape;
  packageId?: string;
  setupPence: number;
  monthlyPence: number;
  oneOffPence: number;
  currency: "GBP";
  /** Printed under the figures — whether VAT applies and on what. */
  vatNote: string;
}

export const PROPOSAL_PRICING_DEFAULT: ProposalPricing = {
  shape: "monthly_on_delivery",
  setupPence: 0,
  monthlyPence: 0,
  oneOffPence: 0,
  currency: "GBP",
  vatNote: "",
};

/**
 * A priced offer to a lead or an existing client, and the only document a
 * stranger can reach without an account.
 *
 * Two things about the shape are deliberate:
 *
 * - **`lead_id` or `client_id`, and at least one.** A proposal is normally
 *   written before anyone is a client — that is the whole point of it — and
 *   acceptance is what turns the lead into one. The check constraint is the
 *   database's version of "every proposal has somebody to send it to", the
 *   same rule `conversations` already carries.
 * - **`public_token` is the only key a client has.** They have no login, so
 *   the token *is* the authorisation: unguessable, one proposal, and every
 *   function on the public path takes it instead of an id so a caller cannot
 *   pass an id it should not know. It is not a signed link like a document's,
 *   because the page it opens must keep working while the client thinks it
 *   over and shows it to a business partner; `valid_until` is what ends it.
 */
export const proposals = pgTable("proposals", {
  ...tenantColumns(),
  leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
  clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
  /** The human handle: `P-2026-014`. Unique per organisation, printed in the footer. */
  reference: text("reference").notNull(),
  title: text("title").notNull(),
  summary: text("summary"),
  scope: jsonb("scope").$type<ProposalScope>().default(PROPOSAL_SCOPE_DEFAULT).notNull(),
  pricing: jsonb("pricing").$type<ProposalPricing>().default(PROPOSAL_PRICING_DEFAULT).notNull(),
  terms: text("terms"),
  /**
   * The last day the client may accept, in Europe/London. A date rather than
   * an instant because "valid until 30 September" is what the document says
   * and what the client reads; `core` turns it into the end of that London day.
   */
  validUntil: date("valid_until", { mode: "string" }),
  status: proposalStatusEnum("status").default("draft").notNull(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  /** Stamped once, by the first view, and never rewritten. */
  firstViewedAt: timestamp("first_viewed_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  publicToken: text("public_token").notNull(),
  /** The rendered PDF the client was sent. The countersigned copy is a second document. */
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
  packageId: uuid("package_id").references(() => packages.id, { onDelete: "set null" }),
  /**
   * Whoever wrote it. Acceptance happens on a public page with no session, so
   * the conversion of the lead into a client is credited to this user rather
   * than to nobody — the client cannot be the actor on a record they cannot
   * see.
   */
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
}, (t) => [
  uniqueIndex("proposals_org_reference").on(t.organisationId, t.reference),
  uniqueIndex("proposals_public_token").on(t.publicToken),
  index("proposals_org_status_created").on(t.organisationId, t.status, t.createdAt),
  index("proposals_org_client").on(t.organisationId, t.clientId),
  index("proposals_org_lead").on(t.organisationId, t.leadId),
  check("proposals_lead_or_client", sql`${t.leadId} is not null or ${t.clientId} is not null`),
]);

/**
 * One priced row of a proposal.
 *
 * Money is integer pence throughout — `quantity * unit_pence`, both integers,
 * so a total is exact arithmetic and never a float that rounds to £249.99.
 * Deleting a proposal takes its lines with it: a line has no meaning of its
 * own and nothing else points at one.
 */
export const proposalLines = pgTable("proposal_lines", {
  ...tenantColumns(),
  proposalId: uuid("proposal_id").notNull().references(() => proposals.id, { onDelete: "cascade" }),
  kind: proposalLineKindEnum("kind").notNull(),
  description: text("description").notNull(),
  quantity: integer("quantity").default(1).notNull(),
  unitPence: integer("unit_pence").default(0).notNull(),
  /** Display order within the proposal. Ties break on `created_at`. */
  sort: integer("sort").default(0).notNull(),
}, (t) => [
  index("proposal_lines_proposal_sort").on(t.proposalId, t.sort),
  index("proposal_lines_org").on(t.organisationId),
]);

/**
 * The record of a client agreeing, and the reason this table exists at all.
 *
 * Shoji's decision was click-to-accept plus our own signature rather than a
 * third-party e-signature service, which means the evidence has to be ours and
 * has to be complete: who typed their name, at what address, at what moment,
 * from which IP and browser, and the signature they actually drew. `document_id`
 * is the countersigned PDF — a second document rather than an edit of the
 * first, so both the file they read and the file they signed survive.
 *
 * **One acceptance per proposal, enforced by the index.** A client on a phone
 * double-taps Accept; the second insert loses to `proposal_acceptances_proposal`
 * and the caller returns the first acceptance rather than writing a second.
 * A read-then-insert would not survive two taps 40 ms apart.
 */
export const proposalAcceptances = pgTable("proposal_acceptances", {
  ...tenantColumns(),
  proposalId: uuid("proposal_id").notNull().references(() => proposals.id, { onDelete: "cascade" }),
  acceptedName: text("accepted_name").notNull(),
  acceptedEmail: text("accepted_email").notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }).defaultNow().notNull(),
  /** As seen by the app, from the proxy headers the web route trusts. */
  ip: text("ip"),
  userAgent: text("user_agent"),
  /** The drawn signature as an SVG path. Sanitised by `core` before it is stored. */
  signatureSvg: text("signature_svg"),
  documentId: uuid("document_id").references(() => documents.id, { onDelete: "set null" }),
}, (t) => [
  uniqueIndex("proposal_acceptances_proposal").on(t.proposalId),
  index("proposal_acceptances_org").on(t.organisationId),
]);
