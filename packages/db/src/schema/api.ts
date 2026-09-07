import { index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantColumns } from "./_shared.js";

/**
 * A key that lets something outside this repository read the business.
 *
 * Mr. Green is the first holder, and the reason this is a table rather than
 * another shared secret in the environment. `PUBLIC_FORMS_TOKEN` and
 * `INBOUND_EMAIL_SECRET` are right for what they do — one webhook each, one
 * caller each, rotated by a deploy. This is different in every way that
 * matters: it is held on a laptop that could be lost, there will eventually be
 * more than one of them, and revoking it must not wait for a container to
 * rebuild. A row can be killed from Settings in a second.
 *
 * **Only the hash is stored.** The token itself is shown once, at the moment it
 * is issued, and never again — not in a log, not in the audit row, not in a
 * list endpoint. `prefix` exists so a person can still tell which row is which
 * on screen without the secret being recoverable from it.
 *
 * SHA-256 rather than bcrypt or argon2, deliberately. Those exist to make brute
 * force expensive against passwords a human chose, which have little entropy.
 * This token is 32 random bytes: there is nothing to guess, and a deliberately
 * slow hash on every API call would buy latency and no safety. GitHub's own
 * personal access tokens work the same way.
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    ...tenantColumns(),
    /** What it is for, in a person's words: "Mr. Green — laptop". */
    name: text("name").notNull(),
    /** Hex SHA-256 of the token. Unique across every organisation, because a collision would be a cross-tenant read. */
    tokenHash: text("token_hash").notNull(),
    /** The first few characters of the token, for telling rows apart on screen. Not a secret and not enough to be one. */
    prefix: text("prefix").notNull(),
    /**
     * Which `PERMISSION_KEYS` this token may read, as the admin already means
     * them. A second vocabulary invented for the API would be a second place
     * to get permissions wrong (spec point 14).
     */
    scopes: text("scopes").array().notNull().default([]),
    /** Null means it does not expire. A date in the past reads as revoked. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Set when a person kills it. Kept rather than deleted so the audit trail still resolves. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * Stamped on use, so a token nobody has touched in months is visibly
     * disposable. Written on a best-effort basis — a failure to stamp must
     * never fail the request it was stamping.
     */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
  },
  (t) => [
    // The lookup path: one indexed equality on the hash, no scan, and the
    // organisation falls out of the row rather than being asked for.
    uniqueIndex("api_tokens_hash").on(t.tokenHash),
    index("api_tokens_org").on(t.organisationId),
  ],
);
