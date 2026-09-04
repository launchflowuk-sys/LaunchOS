/**
 * The one place the seeded logins and the seeded support address live.
 *
 * Every default here must match `packages/db/src/seed.ts` and `.env.example`
 * exactly: a spec that duplicates a literal drifts the moment the seed changes,
 * and the symptom is a two-minute navigation timeout rather than a readable
 * failure. `apps/web/playwright.config.ts` loads the repo-root `.env` before
 * these are read, so a local override in `.env` reaches the specs too.
 */
export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://launchos:launchos@localhost:5432/launchos";

/** The owner account the seed creates. Opens the whole admin shell. */
export const OWNER = {
  email: process.env.SEED_OWNER_EMAIL ?? "shujaat@nexusedu.co.uk",
  password: process.env.SEED_OWNER_PASSWORD ?? "change-me-now",
} as const;

/**
 * The portal login the seed creates for Grays CabLine. It has its **own**
 * password — never the owner's — because the two accounts sit on opposite
 * sides of a privilege boundary, so this must not fall back to `OWNER.password`.
 */
export const CLIENT = {
  email: process.env.SEED_CLIENT_EMAIL ?? "portal@grayscabline.example",
  password: process.env.SEED_CLIENT_PASSWORD ?? "change-me-client",
} as const;

const SUPPORT_EMAIL_DOMAIN = process.env.SUPPORT_EMAIL_DOMAIN ?? "support.launchflow.co.uk";
/** The routable address `seedEmailIdentity` gives the first seeded client. */
export const SUPPORT_ADDRESS = process.env.SEED_SUPPORT_ADDRESS ?? `grays-cabline@${SUPPORT_EMAIL_DOMAIN}`;
/** Shared secret on the inbound webhook. */
export const INBOUND_SECRET = process.env.INBOUND_EMAIL_SECRET ?? "change-me";
