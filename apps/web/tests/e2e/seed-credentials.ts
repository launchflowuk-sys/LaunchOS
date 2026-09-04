/**
 * The one place the seeded logins and the seeded support address live.
 *
 * Every default here must match `packages/db/src/seed.ts` and `.env.example`
 * exactly: a spec that duplicates a literal drifts the moment the seed changes,
 * and the symptom is a two-minute navigation timeout rather than a readable
 * failure. `apps/web/playwright.config.ts` loads the repo-root `.env` before
 * these are read, so a local override in `.env` reaches the specs too.
 *
 * **A blank value is an unset one, for every key** — that is what `fromEnv`
 * below is for, and it is the other half of the invariant above. `.env.example`
 * ships `SEED_OWNER_EMAIL=` blank, dotenv gives a bare `KEY=` the value `""`,
 * and `??` does not fall back on `""`. So `?? default` filled the sign-in form
 * with an empty address on the one setup the quick start produces
 * (`cp .env.example .env`), while `seedConfigFromEnv`
 * (`packages/db/src/seed.ts`) treated the same `""` as unset and created the
 * account under its own default. Every spec then failed as a navigation
 * timeout. `||` is the whole of the difference.
 */

/**
 * A value from the environment, with blank read as unset — the rule
 * `seedConfigFromEnv` applies to `SEED_OWNER_EMAIL`.
 *
 * The trim also normalises the value it returns, which matches the seed for the
 * addresses and diverges from it for the two passwords: the seed hashes
 * `SEED_OWNER_PASSWORD` exactly as given. In practice nothing turns on it —
 * dotenv already strips surrounding whitespace from an unquoted value, and a
 * password that is blank or whitespace-only never reaches a database at all
 * because the seed's `password-floor` guard refuses the run before it connects.
 */
function fromEnv(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

export const DATABASE_URL = fromEnv(process.env.DATABASE_URL, "postgres://launchos:launchos@localhost:5432/launchos");

/** The owner account the seed creates. Opens the whole admin shell. */
export const OWNER = {
  email: fromEnv(process.env.SEED_OWNER_EMAIL, "shujaat@nexusedu.co.uk"),
  password: fromEnv(process.env.SEED_OWNER_PASSWORD, "change-me-now"),
} as const;

/**
 * The portal login the seed creates for Grays CabLine. It has its **own**
 * password — never the owner's — because the two accounts sit on opposite
 * sides of a privilege boundary, so this must not fall back to `OWNER.password`.
 */
export const CLIENT = {
  email: fromEnv(process.env.SEED_CLIENT_EMAIL, "portal@grayscabline.example"),
  password: fromEnv(process.env.SEED_CLIENT_PASSWORD, "change-me-client"),
} as const;

const SUPPORT_EMAIL_DOMAIN = fromEnv(process.env.SUPPORT_EMAIL_DOMAIN, "support.launchflow.co.uk");
/** The routable address `seedEmailIdentity` gives the first seeded client. */
export const SUPPORT_ADDRESS = fromEnv(process.env.SEED_SUPPORT_ADDRESS, `grays-cabline@${SUPPORT_EMAIL_DOMAIN}`);
/** Shared secret on the inbound webhook. */
export const INBOUND_SECRET = fromEnv(process.env.INBOUND_EMAIL_SECRET, "change-me");
