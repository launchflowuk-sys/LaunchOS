import { randomBytes } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { appUrl } from "../config.js";

/** `leads.metadata.bookingToken` — the unguessable handle the `/book?lead=` link carries. */
export const BOOKING_TOKEN_KEY = "bookingToken";

/** The public booking page on the app host. `?lead=<token>` pre-fills the form. */
export const BOOKING_PATH = "/book";

/**
 * Where `MARKETING_URL` points when unset: LaunchFlow's own site. Only read
 * for the contact-page fallback below, which `bookingLinkFor` no longer
 * needs now the booking page exists — kept so the fallback stays one place.
 */
export const DEFAULT_MARKETING_URL = "https://launchflow.co.uk";

export function marketingUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.MARKETING_URL?.trim();
  try {
    return new URL(raw || DEFAULT_MARKETING_URL).toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_MARKETING_URL;
  }
}

/** 32 URL-safe characters: enough that nobody guesses a lead's link, short enough for an email. */
export function mintBookingToken(): string {
  return randomBytes(24).toString("base64url");
}

type LeadLike = Pick<typeof schema.leads.$inferSelect, "metadata">;

/** The token a lead carries, or null for a lead minted before tokens existed. */
export function bookingTokenOf(lead: LeadLike): string | null {
  const raw = lead.metadata[BOOKING_TOKEN_KEY];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * The one place the "book a call" link is built. The acknowledgement email,
 * the qualifier's approved reply and the admin lead page all read it, so the
 * booking flow can move without any of them noticing.
 *
 * With a token: `${APP_URL}/book?lead=<token>` — the booking page pre-fills
 * the guest's name and email and files the meeting under the lead. Without
 * one (a lead created before P1 landed): the marketing site's contact page,
 * so the link still goes somewhere useful.
 */
export function bookingLinkFor(lead: LeadLike, env: NodeJS.ProcessEnv = process.env): string {
  const token = bookingTokenOf(lead);
  if (!token) return `${marketingUrl(env)}/contact`;
  return `${appUrl(env)}${BOOKING_PATH}?lead=${encodeURIComponent(token)}`;
}

/**
 * The lead behind a booking token, across organisations — the public booking
 * page has no organisation of its own until it finds the lead. Null for an
 * unknown or malformed token; the caller treats that as "no pre-fill".
 */
export async function findLeadByBookingToken(db: Db, token: string) {
  const trimmed = token.trim();
  if (trimmed.length < 16 || trimmed.length > 128) return null;
  const [row] = await db
    .select()
    .from(schema.leads)
    .where(and(sql`${schema.leads.metadata}->>${BOOKING_TOKEN_KEY} = ${trimmed}`, isNull(schema.leads.deletedAt)))
    .limit(1);
  return row ?? null;
}

/** Same lookup, scoped to one organisation, for callers that already know theirs. */
export async function findLeadByBookingTokenIn(db: Db, organisationId: string, token: string) {
  const lead = await findLeadByBookingToken(db, token);
  return lead && lead.organisationId === organisationId ? lead : null;
}

/** Gives an older lead a token so its page can show a booking link. Idempotent. */
export async function ensureBookingToken(db: Db, organisationId: string, leadId: string): Promise<string> {
  const [existing] = await db.select({ metadata: schema.leads.metadata }).from(schema.leads)
    .where(and(eq(schema.leads.id, leadId), eq(schema.leads.organisationId, organisationId)));
  if (!existing) throw new Error(`lead ${leadId} not found in organisation`);
  const current = bookingTokenOf(existing);
  if (current) return current;
  const token = mintBookingToken();
  await db.update(schema.leads)
    .set({
      metadata: sql`coalesce(${schema.leads.metadata}, '{}'::jsonb) || ${JSON.stringify({ [BOOKING_TOKEN_KEY]: token })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.leads.id, leadId), eq(schema.leads.organisationId, organisationId), sql`${schema.leads.metadata}->>${BOOKING_TOKEN_KEY} is null`));
  // A concurrent caller may have minted first; read back so both return the same token.
  const [after] = await db.select({ metadata: schema.leads.metadata }).from(schema.leads).where(eq(schema.leads.id, leadId));
  return bookingTokenOf(after!) ?? token;
}
