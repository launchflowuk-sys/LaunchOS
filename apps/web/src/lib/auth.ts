import { schema } from "@launchos/db";
import { MIN_PASSWORD_LENGTH } from "@launchos/db/passwords";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins/two-factor";
import { getDb } from "./db";
import { twoFactorAuditHook } from "./two-factor-audit";

/**
 * What an authenticator app shows above the six digits. The account's email
 * address goes underneath it, so this only has to say which product it is.
 */
const TOTP_ISSUER = "LaunchOS";

function buildAuth() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required");
  return betterAuth({
    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        twoFactor: schema.twoFactor,
      },
    }),
    // The floor for everyone, staff and clients alike. Better Auth's own
    // default is 8, and the portal's change-password form is a browser control
    // anyone can POST past — this is the line that actually enforces it. The
    // number is shared with `db:bootstrap` and `db:seed`, which write
    // credentials straight into the `account` table where Better Auth never
    // re-validates them; a literal here would let the two drift.
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: MIN_PASSWORD_LENGTH },
    secret,
    baseURL: process.env.BETTER_AUTH_URL ?? process.env.APP_URL ?? "http://localhost:3000",
    // TOTP only, from an authenticator app, with single-use backup codes.
    // No email or SMS second factor: an emailed code protects nothing once
    // the mailbox is the thing that has been taken, and there is no SMS
    // provider here to send one through.
    //
    // `skipVerificationOnEnable` stays off, which is the whole safety
    // property of the enrolment flow: `/two-factor/enable` writes an
    // *unverified* row and the factor only goes live once the person has
    // typed a code their app actually produced. A phone that scanned the QR
    // badly, or an authenticator on the wrong clock, therefore cannot lock
    // anybody out — nothing changes about how they sign in until it works.
    //
    // The backup codes are AES-256-GCM encrypted under `secret` rather than
    // hashed. That is not a choice: verifying one means recovering the
    // remaining list and writing it back one code shorter, which a one-way
    // hash cannot do. They are `returned: false` in the plugin's schema, are
    // shown to the person exactly once at enrolment, and appear in no log.
    plugins: [
      twoFactor({
        issuer: TOTP_ISSUER,
        backupCodeOptions: { storeBackupCodes: "encrypted" },
        // Nobody enables, disables or replaces codes without their password.
        // A live session on a stolen laptop is not enough to take the second
        // factor off the account it is protecting.
        allowPasswordless: false,
      }),
    ],
    hooks: { after: twoFactorAuditHook },
  });
}

let cached: ReturnType<typeof buildAuth> | undefined;

/**
 * The Better Auth instance, built on first use and cached for the process.
 * Lazy for the same reason as `getDb`: `next build` must not need secrets or
 * a database.
 */
export function getAuth(): ReturnType<typeof buildAuth> {
  if (!cached) cached = buildAuth();
  return cached;
}
