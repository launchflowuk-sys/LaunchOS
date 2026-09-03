import { schema } from "@launchos/db";
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
    emailAndPassword: { enabled: true },
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
