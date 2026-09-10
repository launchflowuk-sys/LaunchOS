import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { hashSecret } from "./sessions.js";

/**
 * Getting back into a draft from a link in an email.
 *
 * Three decisions carry this, and each exists because of a specific way the
 * obvious version goes wrong.
 *
 * **The token is hashed and one-time.** A mailbox is not a secret store: mail
 * sits in backups, on shared machines and in forwarded threads. A link that
 * works twice works for whoever else has the thread.
 *
 * **A GET must not consume it.** Outlook, Gmail and every link-preview service
 * fetch URLs in mail before a person ever clicks. A token spent by a scanner is
 * a support call nobody can diagnose. So landing on the link shows a neutral
 * Continue, and only the POST behind that button exchanges it.
 *
 * **Every failure answers identically.** Unknown address, wrong token, expired,
 * already used, revoked — all the same neutral reply. Anything else turns this
 * into a way to ask whether a given email has a project with us.
 */

/** Long enough to survive a weekend, short enough that a leaked thread goes stale. */
export const RESUME_TOKEN_TTL_HOURS = 48;

/** Hex, so it survives an email client without being re-encoded. */
function newToken(): string {
  return randomBytes(32).toString("hex");
}

export interface IssuedResumeToken {
  /** The only time this value exists. Goes straight into the link and is not stored. */
  token: string;
  expiresAt: Date;
}

/**
 * Issues a link back into a draft.
 *
 * Any token already outstanding for the draft is revoked first. Two live links
 * for one draft means the older mail still works after the newer one is used,
 * which is exactly the thing one-time is supposed to prevent.
 */
export async function issueResumeToken(
  db: Db,
  organisationId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<IssuedResumeToken> {
  const token = newToken();
  const expiresAt = new Date(now.getTime() + RESUME_TOKEN_TTL_HOURS * 60 * 60 * 1000);

  return db.transaction(async (tx) => {
    await tx
      .update(schema.briefResumeTokens)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.briefResumeTokens.sessionId, sessionId),
          isNull(schema.briefResumeTokens.consumedAt),
          isNull(schema.briefResumeTokens.revokedAt),
        ),
      );

    await tx.insert(schema.briefResumeTokens).values({
      organisationId,
      sessionId,
      tokenHash: hashSecret(token),
      expiresAt,
    });

    return { token, expiresAt };
  });
}

/**
 * The draft that a request should get a link for, found by email address.
 *
 * Newest first, and only a draft — somebody who already sent their brief has
 * nothing to come back to. Returns null for everything else, and the caller
 * must answer the same way either way.
 */
export async function draftForEmail(
  db: Db,
  organisationId: string,
  email: string,
): Promise<{ sessionId: string; leadId: string } | null> {
  const clean = email.trim().toLowerCase();
  if (!clean) return null;

  const rows = await db
    .select({ sessionId: schema.briefSessions.id, leadId: schema.briefSessions.leadId })
    .from(schema.briefSessions)
    .innerJoin(schema.leads, eq(schema.leads.id, schema.briefSessions.leadId))
    .where(
      and(
        eq(schema.briefSessions.organisationId, organisationId),
        eq(schema.briefSessions.status, "draft"),
        eq(schema.leads.email, clean),
      ),
    )
    .orderBy(desc(schema.briefSessions.lastActivityAt));

  const found = rows[0];
  return found?.leadId ? { sessionId: found.sessionId, leadId: found.leadId } : null;
}

export type ExchangeResult =
  | { ok: true; sessionId: string; secret: string }
  | { ok: false };

/**
 * Spends a token and hands back a fresh cookie secret.
 *
 * The session secret is **rotated**, not reused. A resume link is used because
 * the old browser is gone — a new laptop, a wiped phone, a different person at
 * the same company — and leaving the previous secret working would mean an
 * abandoned device keeping access to a draft its owner has moved on from.
 *
 * The consume and the rotation are one transaction. Split, a crash between them
 * either burns a token that granted nothing or grants access on a token still
 * marked unused.
 */
export async function exchangeResumeToken(
  db: Db,
  organisationId: string,
  token: string,
  now: Date = new Date(),
): Promise<ExchangeResult> {
  if (!token) return { ok: false };
  const tokenHash = hashSecret(token);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.briefResumeTokens)
      .where(
        and(
          eq(schema.briefResumeTokens.organisationId, organisationId),
          eq(schema.briefResumeTokens.tokenHash, tokenHash),
        ),
      );

    // Unknown, spent, revoked and expired all answer the same way.
    if (!row) return { ok: false as const };
    if (row.consumedAt || row.revokedAt) return { ok: false as const };
    if (row.expiresAt <= now) return { ok: false as const };

    const [session] = await tx
      .select()
      .from(schema.briefSessions)
      .where(eq(schema.briefSessions.id, row.sessionId));
    if (!session || session.status !== "draft") return { ok: false as const };

    await tx
      .update(schema.briefResumeTokens)
      .set({ consumedAt: now, updatedAt: now })
      .where(eq(schema.briefResumeTokens.id, row.id));

    const secret = randomBytes(32).toString("base64url");
    await tx
      .update(schema.briefSessions)
      .set({ sessionSecretHash: createHash("sha256").update(secret).digest("hex"), lastActivityAt: now, updatedAt: now })
      .where(eq(schema.briefSessions.id, session.id));

    return { ok: true as const, sessionId: session.id, secret };
  });
}
