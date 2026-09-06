import { randomBytes } from "node:crypto";
import { z } from "zod";

/**
 * The one way a client agrees to something, in the primitives every kind of
 * agreement shares.
 *
 * A proposal is accepted and a finished build is signed off. They are
 * different business events on different tables, but the *mechanism* is one
 * thing: an unguessable token in a URL, a name and an email typed by whoever
 * opened it, and a signature drawn with a finger. This module is that
 * mechanism, so there is exactly one place the rules are written down and
 * neither kind can quietly acquire its own dialect of them.
 *
 * `proposals/shared.ts` re-exports these under the names it already published;
 * nothing there was rewritten, and nothing here is a second implementation of
 * what was there.
 */

/** The shortest and longest a public token can legitimately be — junk never reaches a query. */
const TOKEN_MIN = 16;
const TOKEN_MAX = 128;

/**
 * The token in the URL, and the only key a client holds.
 *
 * 24 random bytes — 192 bits — base64url, which is 32 characters. Unguessable
 * in the only sense that matters: an attacker who can try a million a second
 * is still far past the heat death of the sun from the first hit, so the token
 * is the authorisation and nothing else needs to be.
 *
 * Not a signed, expiring token like a document's. A document link is minted
 * per email and can be re-minted; this is the client's bookmark while they
 * read something over and show it to a business partner, so it has to keep
 * working. What ends it is a business fact — a proposal's `valid_until`, a
 * sign-off already recorded — not a clock.
 */
export function mintPublicToken(): string {
  return randomBytes(24).toString("base64url");
}

/** A trimmed token, or null when the string could not be one. */
export function normalisePublicToken(token: string): string | null {
  const trimmed = token.trim();
  if (trimmed.length < TOKEN_MIN || trimmed.length > TOKEN_MAX) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
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
 * The box every capture canvas normalises to, so a stored signature scales the
 * same way in every document. The public page's contract, not a suggestion.
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
 * The evidence every agreement records, as one set of Zod fields.
 *
 * Shoji's decision was click-to-accept plus our own signature rather than a
 * third-party e-signature service, which means the evidence has to be ours and
 * has to be complete — who typed their name, at what address, from which IP
 * and browser, and the mark they drew. Spreading these into each input schema
 * is what keeps that promise identical on both paths.
 */
export const AGREEMENT_EVIDENCE_FIELDS = {
  /** SVG path data from the signature canvas, normalised to `SIGNATURE_VIEWBOX`. */
  signatureSvg: SignaturePathSchema.optional(),
  ip: z.string().trim().max(64).optional(),
  userAgent: z.string().trim().max(500).optional(),
} as const;
