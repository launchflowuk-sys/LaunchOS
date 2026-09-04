import { schema } from "@launchos/db";
import { MIN_PASSWORD_LENGTH } from "@launchos/db/passwords";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getDb } from "./db";

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
