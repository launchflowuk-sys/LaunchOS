import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { verifyDocumentToken, type DocumentTokenRefusal } from "./document-link.js";
import { getDocument, readDocumentBytes, type DocumentRow } from "./store-document.js";

/**
 * The three — and only three — ways a document's bytes leave this system.
 *
 * 1. `readDocumentForOwner` — an admin session, scoped to its organisation.
 * 2. `readDocumentForClient` — a portal session, scoped to its organisation
 *    *and* its client. A client user may read their own paperwork and nobody
 *    else's, including another client's in the same organisation.
 * 3. `readSignedDocument` — a link in an email, with no session at all,
 *    proven by the HMAC in `document-link.ts`.
 *
 * All three answer the same shape so the route can treat them alike, and all
 * three refuse the same way: **`not_found` for everything except an expired
 * link**. A reader who tampers with a signature must not be told they had the
 * right document id and the wrong key — that is an oracle, and it is how a
 * enumerated uuid becomes a confirmed one. Expiry is the exception because it
 * is the one refusal the reader can act on: "ask us for a fresh link" is
 * useful, and it reveals only that a link they already held has aged out.
 *
 * Reads are deliberately not written to `audit_log`. A GET is not a business
 * write, a browser will issue several for one open document, and the events
 * that actually matter — a proposal first viewed, a signed copy downloaded —
 * are recorded against the proposal by the release that owns it.
 */

export type DocumentAccessRefusal = "not_found" | "expired";

export type DocumentAccessResult =
  | { ok: true; document: DocumentRow; bytes: Buffer }
  | { ok: false; reason: DocumentAccessRefusal };

const NOT_FOUND = { ok: false, reason: "not_found" } as const;

/** Bytes for a row already proven to belong to the caller, or `not_found`. */
async function withBytes(document: DocumentRow, env: NodeJS.ProcessEnv): Promise<DocumentAccessResult> {
  const bytes = await readDocumentBytes(document, env);
  return bytes ? { ok: true, document, bytes } : NOT_FOUND;
}

export const ReadDocumentInput = z.object({ documentId: z.string().uuid() });
export type ReadDocumentInput = z.input<typeof ReadDocumentInput>;

/** The owner or a staff member, through their admin session. */
export async function readDocumentForOwner(
  db: Db,
  organisationId: string,
  input: ReadDocumentInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DocumentAccessResult> {
  const v = ReadDocumentInput.parse(input);
  const document = await getDocument(db, organisationId, v);
  return document ? withBytes(document, env) : NOT_FOUND;
}

export const ReadClientDocumentInput = ReadDocumentInput.extend({ clientId: z.string().uuid() });
export type ReadClientDocumentInput = z.input<typeof ReadClientDocumentInput>;

/**
 * A client user, through their portal session.
 *
 * `clientId` comes from the session, never from the request — the same rule
 * the portal's asset upload follows. A document with no client (a proposal
 * still attached to a lead) is not readable here at all: nobody has a portal
 * account for a lead, and returning one to whichever client happened to ask
 * would be the exact tenancy hole this function exists to close.
 */
export async function readDocumentForClient(
  db: Db,
  organisationId: string,
  input: ReadClientDocumentInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DocumentAccessResult> {
  const v = ReadClientDocumentInput.parse(input);
  const document = await getDocument(db, organisationId, { documentId: v.documentId });
  if (!document || document.clientId !== v.clientId) return NOT_FOUND;
  return withBytes(document, env);
}

export const ReadSignedDocumentInput = ReadDocumentInput.extend({
  token: z.string().min(1).max(400),
  now: z.date().optional(),
});
export type ReadSignedDocumentInput = z.input<typeof ReadSignedDocumentInput>;

/** `expired` is the one refusal a reader is told about; see the header. */
const REFUSAL: Readonly<Record<DocumentTokenRefusal, DocumentAccessRefusal>> = {
  malformed: "not_found",
  bad_signature: "not_found",
  expired: "expired",
};

/**
 * A document opened from a link in an email, with no session.
 *
 * The row is looked up by id alone — the reader has no organisation to scope
 * by, which is the whole difficulty — and the organisation then comes *from
 * the row* into the signature check. A token minted for organisation A over
 * document id X therefore fails against organisation B's document, even in the
 * impossible case of a repeated uuid: the payload would not match. The
 * signature, not the query, decides which tenant this read belongs to.
 */
export async function readSignedDocument(
  db: Db,
  input: ReadSignedDocumentInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DocumentAccessResult> {
  const v = ReadSignedDocumentInput.parse(input);
  const [document] = await db.select().from(schema.documents)
    .where(and(eq(schema.documents.id, v.documentId), isNull(schema.documents.deletedAt)));
  if (!document) return NOT_FOUND;

  const verified = verifyDocumentToken(
    {
      organisationId: document.organisationId,
      documentId: document.id,
      token: v.token,
      ...(v.now ? { now: v.now } : {}),
    },
    env,
  );
  if (!verified.ok) return { ok: false, reason: REFUSAL[verified.reason] };
  return withBytes(document, env);
}

/**
 * `content-disposition` for a document.
 *
 * `inline`, so a client clicking the link in an email reads the proposal in
 * their browser rather than finding it in Downloads. The filename is built
 * from the reference rather than the stored uuid, and reduced to characters
 * that cannot end the quoted string or start another parameter — the same
 * rule, for the same reason, as `attachmentContentDisposition`.
 */
export function documentContentDisposition(document: Pick<DocumentRow, "reference">): string {
  const name = `${document.reference.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80) || "document"}.pdf`;
  return `inline; filename="${name}"`;
}
