import { randomBytes } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull, like } from "drizzle-orm";
import { z } from "zod";
import { appUrl } from "../config.js";
import { zonedParts, zonedTimeToUtc } from "../meetings/time.js";

/**
 * Re-exported from the schema so every module in this folder has one import
 * for "what a proposal is" rather than two.
 */
export { PROPOSAL_DECIDED_STATUSES, PROPOSAL_LIVE_STATUSES } from "@launchos/db/schema";

export type ProposalRow = typeof schema.proposals.$inferSelect;
export type ProposalLineRow = typeof schema.proposalLines.$inferSelect;
export type ProposalAcceptanceRow = typeof schema.proposalAcceptances.$inferSelect;

export const ActorKindSchema = z.enum(["user", "client", "agent", "system"]);
export type ActorKind = z.infer<typeof ActorKindSchema>;

/** The audit target type every proposal action is recorded under. */
export const PROPOSAL_TARGET_TYPE = "proposal";
/** `documents.subject_type` for both the sent copy and the countersigned one. */
export const PROPOSAL_SUBJECT_TYPE = "proposal";

/** Everything a proposal can refuse to do, and the message the caller shows. */
export class ProposalRefused extends Error {
  constructor(
    readonly reason:
      | "not_found"
      | "not_editable"
      | "not_sendable"
      | "not_live"
      | "no_recipient"
      | "no_price"
      | "shape_mismatch"
      | "expired",
    message: string,
  ) {
    super(message);
    this.name = "ProposalRefused";
  }
}

/**
 * The public page a proposal is read on. Served on the marketing host and the
 * app host alike, the way `/book` and `/signup` are.
 */
export const PROPOSAL_PUBLIC_PATH = "/p";

/**
 * The token in the URL, and the only key a client holds.
 *
 * 24 random bytes — 192 bits — base64url, which is 32 characters. Unguessable
 * in the only sense that matters: an attacker who can try a million a second
 * is still 10^40 years from the first hit, so the token is the authorisation
 * and nothing else needs to be.
 *
 * Not a signed, expiring token like a document's, and for a reason. A document
 * link is minted per email and can be re-minted; a proposal's URL is the
 * client's bookmark while they think it over and forward it to a business
 * partner, so it has to keep working. What ends it is `valid_until`, which is
 * a business fact printed on the document, not a cryptographic one.
 */
export function mintProposalToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The shortest and longest a token can legitimately be — junk never reaches a query. */
const TOKEN_MIN = 16;
const TOKEN_MAX = 128;

/** A trimmed token, or null when the string could not be one. */
export function normaliseProposalToken(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length < TOKEN_MIN || trimmed.length > TOKEN_MAX) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/** Where the client reads it. */
export function proposalPublicUrl(proposal: Pick<ProposalRow, "publicToken">, env: NodeJS.ProcessEnv = process.env): string {
  return `${appUrl(env)}${PROPOSAL_PUBLIC_PATH}/${encodeURIComponent(proposal.publicToken)}`;
}

/**
 * The drawn signature, as SVG path data and nothing else.
 *
 * A signature arrives from a public page with no session, and ends up inside
 * an HTML document we hand to Chromium and then keep as evidence. Storing a
 * whole `<svg>` element would mean trusting a stranger's markup in a renderer
 * — so only the `d` attribute of a single path is accepted, matched against
 * the SVG path grammar, and `signatureSvgMarkup` below builds the element
 * around it. There is no character in this set that can open a tag.
 */
const SIGNATURE_PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]*$/;
/** Long enough for a careful signature at canvas resolution; a megabyte is a payload. */
export const MAX_SIGNATURE_CHARS = 100_000;
/**
 * The box the capture canvas normalises to, so every stored signature scales
 * the same way in a document. The public page's contract, not a suggestion.
 */
export const SIGNATURE_VIEWBOX = "0 0 600 200";

export const SignaturePathSchema = z
  .string()
  .trim()
  .max(MAX_SIGNATURE_CHARS)
  .refine((value) => SIGNATURE_PATH.test(value), "a signature must be SVG path data");

/** The safe `<svg>` for a stored path. Built here so no caller improvises one. */
export function signatureSvgMarkup(path: string): string {
  return `<svg viewBox="${SIGNATURE_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Signature"><path d="${path}" fill="none" stroke="#0f172a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/**
 * The instant a proposal stops being acceptable: the end of `valid_until` in
 * Europe/London.
 *
 * `valid_until` is a date because that is what the document says — "valid
 * until 30 September" — and a client who accepts at half past eleven that
 * night has accepted in time. Midnight UTC would have cut them off an hour
 * early in summer, which is exactly the sort of thing nobody notices until it
 * loses a sale.
 */
export function proposalExpiresAt(validUntil: string | null): Date | null {
  if (!validUntil) return null;
  const [year, month, day] = validUntil.split("-").map(Number);
  if (!year || !month || !day) return null;
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  return zonedTimeToUtc(
    { year: nextDay.getUTCFullYear(), month: nextDay.getUTCMonth() + 1, day: nextDay.getUTCDate() },
    "Europe/London",
  );
}

/** True once the client can no longer accept, whatever the status column says. */
export function hasExpired(proposal: Pick<ProposalRow, "validUntil">, now: Date): boolean {
  const expiresAt = proposalExpiresAt(proposal.validUntil);
  return expiresAt !== null && now.getTime() >= expiresAt.getTime();
}

/** "30 September 2026" — how a validity date reads in a document or an email. */
export function formatValidUntil(validUntil: string): string {
  const [year, month, day] = validUntil.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

const REFERENCE_DIGITS = 3;

/**
 * The next human reference for this organisation: `P-2026-014`.
 *
 * Per year and per organisation, read from the highest reference already
 * issued rather than from a counter, so a deleted proposal never causes a
 * number to be reused and there is nothing extra to keep in step. The unique
 * index on `(organisation_id, reference)` is what actually decides a race;
 * `createProposal` retries once against it.
 */
export async function nextProposalReference(db: Db, organisationId: string, now: Date = new Date()): Promise<string> {
  const year = zonedParts(now, "Europe/London").year;
  const prefix = `P-${year}-`;
  const [latest] = await db
    .select({ reference: schema.proposals.reference })
    .from(schema.proposals)
    .where(and(eq(schema.proposals.organisationId, organisationId), like(schema.proposals.reference, `${prefix}%`)))
    .orderBy(desc(schema.proposals.reference))
    .limit(1);
  const previous = latest ? Number.parseInt(latest.reference.slice(prefix.length), 10) : 0;
  const next = Number.isFinite(previous) ? previous + 1 : 1;
  return `${prefix}${String(next).padStart(REFERENCE_DIGITS, "0")}`;
}

/** Postgres' "duplicate key", however deeply drizzle wrapped it. */
export function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? (e as { code?: unknown }).code : undefined);
  return code(error) === "23505" || code((error as { cause?: unknown })?.cause) === "23505";
}

/** One proposal in this organisation. Null when it is another tenant's, or gone. */
export async function getProposal(db: Db, organisationId: string, proposalId: string): Promise<ProposalRow | null> {
  const [row] = await db
    .select()
    .from(schema.proposals)
    .where(and(
      eq(schema.proposals.id, proposalId),
      eq(schema.proposals.organisationId, organisationId),
      isNull(schema.proposals.deletedAt),
    ));
  return row ?? null;
}

/** The same, or a `ProposalRefused("not_found")` — for the callers that always need one. */
export async function requireProposal(db: Db, organisationId: string, proposalId: string): Promise<ProposalRow> {
  const proposal = await getProposal(db, organisationId, proposalId);
  if (!proposal) throw new ProposalRefused("not_found", "That proposal could not be found.");
  return proposal;
}

/**
 * By the public token, across organisations — the public page has no
 * organisation until it has found the proposal, exactly as the booking page
 * has none until it has found the meeting.
 */
export async function getProposalByToken(db: Db, token: string): Promise<ProposalRow | null> {
  const normalised = normaliseProposalToken(token);
  if (!normalised) return null;
  const [row] = await db
    .select()
    .from(schema.proposals)
    .where(and(eq(schema.proposals.publicToken, normalised), isNull(schema.proposals.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** The lines of a proposal, in the order the document prints them. */
export async function listProposalLines(db: Db, organisationId: string, proposalId: string): Promise<ProposalLineRow[]> {
  return db
    .select()
    .from(schema.proposalLines)
    .where(and(
      eq(schema.proposalLines.proposalId, proposalId),
      eq(schema.proposalLines.organisationId, organisationId),
      isNull(schema.proposalLines.deletedAt),
    ))
    .orderBy(schema.proposalLines.sort, schema.proposalLines.createdAt, schema.proposalLines.id);
}

/** The acceptance, if the client has agreed. One per proposal, by index. */
export async function getProposalAcceptance(db: Db, organisationId: string, proposalId: string): Promise<ProposalAcceptanceRow | null> {
  const [row] = await db
    .select()
    .from(schema.proposalAcceptances)
    .where(and(
      eq(schema.proposalAcceptances.proposalId, proposalId),
      eq(schema.proposalAcceptances.organisationId, organisationId),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Who a proposal's writes are credited to when nobody is signed in.
 *
 * Acceptance happens on a public page: the person clicking has no account and
 * cannot be the actor on records they will never see. The proposal's author is
 * the honest answer, and the organisation's owner is the fallback for a
 * proposal an agent drafted. `convertLeadToClient` requires a user id, and
 * this is where it comes from.
 */
export async function proposalActorUserId(db: Db, organisationId: string, proposal: Pick<ProposalRow, "createdByUserId">): Promise<string | null> {
  if (proposal.createdByUserId) return proposal.createdByUserId;
  const [owner] = await db
    .select({ userId: schema.organisationMembers.userId })
    .from(schema.organisationMembers)
    .where(and(
      eq(schema.organisationMembers.organisationId, organisationId),
      eq(schema.organisationMembers.role, "owner"),
      eq(schema.organisationMembers.status, "active"),
    ))
    .orderBy(schema.organisationMembers.createdAt)
    .limit(1);
  return owner?.userId ?? null;
}

/** The email address a proposal is sent to and answered from. Null when there is none. */
export async function proposalRecipient(
  db: Db,
  organisationId: string,
  proposal: Pick<ProposalRow, "leadId" | "clientId">,
): Promise<{ name: string; email: string } | null> {
  if (proposal.clientId) {
    const [client] = await db
      .select({ name: schema.clients.name, email: schema.clients.email })
      .from(schema.clients)
      .where(and(eq(schema.clients.id, proposal.clientId), eq(schema.clients.organisationId, organisationId)));
    if (client?.email) return { name: client.name, email: client.email };
  }
  if (proposal.leadId) {
    const [lead] = await db
      .select({ name: schema.leads.name, email: schema.leads.email })
      .from(schema.leads)
      .where(and(eq(schema.leads.id, proposal.leadId), eq(schema.leads.organisationId, organisationId)));
    if (lead?.email) return { name: lead.name, email: lead.email };
  }
  return null;
}
