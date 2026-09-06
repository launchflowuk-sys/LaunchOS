import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// Better Auth core tables for Better Auth 1.7.x (drizzle adapter, pg provider).
//
// Reconciled against `pnpm dlx @better-auth/cli generate --config src/lib/auth.ts`
// run from apps/web, then corrected against the runtime's own table definition
// (`getAuthTables` in @better-auth/core/db): the only published CLI is 1.4.x and
// it omits `account.issuer` plus the unique (issuer, account_id) index that 1.7
// sign-in requires. Re-check both when better-auth is upgraded.
//
// Two deliberate deviations from the generated output:
//  1. every timestamp is `withTimezone: true`, matching the rest of the schema
//     (Better Auth passes Date objects, so timestamptz is a safe superset);
//  2. `updatedAt` keeps `.defaultNow()` so direct inserts (the seed) do not
//     have to supply it. `$onUpdate` still refreshes it on every write.
// Do not hand-edit anything else here: re-run the generator instead.

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  // Added by the `twoFactor` plugin, not by the core tables. False for every
  // account that has never enrolled, which is every account before this
  // migration — enrolment is opt-in and nothing switches it on for anybody.
  twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    // Synthetic issuer namespace, "local:<providerId>" for credential logins
    // (createLocalAccountIssuer in @better-auth/core/db).
    issuer: text("issuer").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index("account_userId_idx").on(t.userId),
    uniqueIndex("account_issuer_accountId_idx").on(t.issuer, t.accountId),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/**
 * Better Auth's `twoFactor` model — one row per enrolled user, written only by
 * the two-factor plugin. Both credential columns are `returned: false` in the
 * plugin's own schema, so nothing that serialises a user can carry them out.
 *
 * `secret` is the TOTP seed and `backupCodes` the recovery codes, both
 * AES-256-GCM encrypted by the plugin under `BETTER_AUTH_SECRET` before they
 * arrive here — the codes cannot be *hashed*, because verification has to
 * recover the remaining list and write it back one code shorter. Rotating that
 * secret therefore orphans every enrolment: see the recovery section of
 * `docs/DEPLOYMENT.md`.
 *
 * `verified` is false between `/two-factor/enable` and the first correct code,
 * which is what stops a half-finished enrolment locking anybody out; the
 * failure counter and `lockedUntil` are the plugin's per-account lockout
 * (ten consecutive failures, fifteen minutes).
 */
export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true).notNull(),
    failedVerificationCount: integer("failed_verification_count").default(0).notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("two_factor_userId_idx").on(t.userId), index("two_factor_secret_idx").on(t.secret)],
);
