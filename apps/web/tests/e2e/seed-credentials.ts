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
 *
 * **`INBOUND_EMAIL_SECRET` is the one key with no default at all.** It is a
 * credential rather than a fixture, the web app refuses to start without a real
 * one, and a default published here would be exactly the value that refusal
 * exists to catch. It throws at import instead — see `requiredFromEnv`.
 *
 * `DATABASE_URL` lives here too so the specs share one connection string. Seven
 * of them used to declare their own `?? "postgres://…"` copy, which meant a
 * blank `DATABASE_URL=` in `.env` reached them as `""` — the same bug as the
 * owner email, one key over.
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

/**
 * A value with no default, because publishing one would be the bug.
 *
 * `INBOUND_EMAIL_SECRET` is the only credential on
 * `POST /api/webhooks/email/inbound`, and the web app now refuses to start on a
 * blank one, on anything under 24 characters, and on every placeholder this
 * repository has ever shipped (`apps/web/src/lib/env.ts`). A fallback here
 * would put one of those placeholders back — in a file that is committed — and
 * a spec that quietly signs with the wrong secret fails as a 401 buried inside
 * a fetch rather than as a missing variable. So it throws, by name, at import.
 */
function requiredFromEnv(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    throw new Error(
      `${name} is not set. The e2e suite signs the inbound webhook with it and the web app refuses to start without it — ` +
        `set it in the repo-root .env (\`openssl rand -base64 48\`) and restart the dev server so both sides carry the same value.`,
    );
  }
  return trimmed;
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
/** Shared secret on the inbound webhook. No default — see `requiredFromEnv`. */
export const INBOUND_SECRET = requiredFromEnv("INBOUND_EMAIL_SECRET", process.env.INBOUND_EMAIL_SECRET);
