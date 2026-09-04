/**
 * The password floor and the passwords published in this repository, in one
 * place.
 *
 * Both scripts that can write a credential — `pnpm db:bootstrap` and
 * `pnpm db:seed` — read their rules from here, so the two cannot drift and
 * neither can be more permissive than the application.
 *
 * `MIN_PASSWORD_LENGTH` is the floor itself, not a copy of one. It is what
 * Better Auth is configured with in `apps/web/src/lib/auth.ts`
 * (`minPasswordLength`) and what the portal's change-password form checks
 * before the round trip — both import it from here, via the
 * `@launchos/db/passwords` subpath, so the number cannot drift between the
 * scripts and the application. That subpath exists because this module has no
 * imports at all: a React client component can pull the constant in without
 * dragging the Postgres client `@launchos/db`'s main entry point loads.
 *
 * Better Auth applies its option on sign-up, change and reset only — `sign-in`
 * never re-checks it — so a credential written straight into the `account`
 * table is never validated again for the life of the account. That is why the
 * floor is enforced here too, in every environment rather than only in
 * production: a short password installed by a script is a short password
 * forever.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Published in this repository, so they must never reach a live database. */
export const DEFAULT_OWNER_PASSWORD = "change-me-now";
export const DEFAULT_CLIENT_PASSWORD = "change-me-client";

/** The first owner's address when `SEED_OWNER_EMAIL` is unset. */
export const DEFAULT_OWNER_EMAIL = "shujaat@nexusedu.co.uk";

/** Every password literal this repository ships. Checked by value, not by variable. */
export const PUBLISHED_DEFAULT_PASSWORDS: readonly string[] = [DEFAULT_OWNER_PASSWORD, DEFAULT_CLIENT_PASSWORD];

export function isPublishedDefaultPassword(value: string): boolean {
  return PUBLISHED_DEFAULT_PASSWORDS.includes(value);
}

/**
 * The message a guard uses when a password is under the floor. Exported so the
 * bootstrap and the seed word the same refusal the same way, and so a test can
 * assert on it without copying the string.
 */
export function shortPasswordMessage(variableName: string, value: string): string {
  return (
    `${variableName} is ${value.length} characters; the minimum is ${MIN_PASSWORD_LENGTH}. ` +
    "That is the floor apps/web/src/lib/auth.ts enforces on every staff and client account, " +
    "and Better Auth never re-checks a password written directly into the database — so a short " +
    "one set here would stand forever. Set a longer one."
  );
}
