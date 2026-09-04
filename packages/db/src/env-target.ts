/**
 * What "production" means to `pnpm db:seed`.
 *
 * **This predicate guards demo fixtures, not credentials.** The two guards that
 * stop a published password or an unconfirmed slug — `published-default` and
 * `confirm-slug` in `./bootstrap.ts` — do not consult it at all: they run in
 * every environment, against every host, because no host string can tell a
 * local database from a production one reached through an SSH tunnel
 * (`ssh -L 5433:…` presents a live database as `localhost:5433`) or over a
 * private network (Hetzner Cloud private networks are `10.0.0.0/16`; this
 * repository's own production compose file names its database `postgres`).
 *
 * What is left is the seed's `demo-fixtures-in-production` gate and its refusal
 * to write a published default, where the inference is worth having and the
 * cost of being wrong runs the other way: keying those on `NODE_ENV` alone
 * meant a demo seed against a live database from a shell where nobody exported
 * `NODE_ENV` was the one run that skipped them, while treating a laptop's
 * docker Postgres as production would refuse every local `pnpm db:seed`.
 *
 * A run is a **production target** unless the database it is pointed at is
 * demonstrably local:
 *
 * - `localhost`, `127.0.0.1` (any `127.x` loopback), or IPv6 loopback in any
 *   spelling (`::1`, `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`);
 * - `postgres` or `db`, the docker-compose service names this repo ships;
 * - an RFC1918 address (`10/8`, `172.16/12`, `192.168/16`) or an IPv6
 *   unique-local address (`fc00::/7`), which is a docker bridge or a LAN box,
 *   not a hosted database.
 *
 * Everything else is treated as production: a public hostname, a Coolify
 * service address, a missing or unparseable URL, a **hostless** URL (the unix
 * socket form `postgres:///launchos`) and a comma-separated **multi-host** URL,
 * both of which postgres.js accepts and `new URL` does not resolve to a single
 * host we can judge. Erring that way costs a developer one environment
 * variable; erring the other way writes demo invoices, numbered from a live
 * sequence, into a live tenant.
 *
 * `NODE_ENV=production` still forces production on, so nothing that was
 * guarded before is guarded less now.
 *
 * The repo-root `.env` loader lives here too, beside the predicate that judges
 * what it loaded. It is here rather than in `./bootstrap.ts` because this
 * module imports nothing but `node:path` / `node:url`, so every script in the
 * package — including `./scripts/reconcile-support-emails.ts`, a repair tool
 * that must still start in an image where `better-auth` or the workspace's dev
 * dependencies are absent — can read the same file the same way without
 * dragging the bootstrap's dependencies into its module graph. `./bootstrap.ts`
 * re-exports both for its existing callers.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repo-root `.env`, resolved from **this file's own location** — never from
 * `process.cwd()`.
 *
 * This module is `<repo>/packages/db/src/env-target.ts`, so the root is three
 * directories up. A ladder of `../../.env`, `../.env`, `.env` candidates
 * resolved against the cwd was only correct for the one supported invocation
 * (cwd `packages/db`); run from the repository root — which is what "a one-off
 * from a restore box or a maintenance container" looks like — `../../.env`
 * resolves *two directories above the repository*, and a stray file there would
 * win the ladder, supply the configuration, and be reported as "the env file"
 * while the repository's own `.env` went unread.
 *
 * **The invariant this depends on: this module must sit exactly three
 * directories below the repository root in every layout it is executed from.**
 * True from `src/` and, today, from the built output as well — `tsconfig.json`
 * has `rootDir: "src"`, so `dist/env-target.js` is the same depth as
 * `src/env-target.ts` — but that is a consequence of the build settings, not of
 * this line. A build that emitted `dist/src/`, or a bundle written anywhere
 * else in the package, would make this resolve to `packages/` instead:
 * `loadRootEnv` would then find nothing, return null, and the run would fall
 * back to the built-in defaults behind an `env file none found at …` line
 * nobody reads. If the emitted layout ever changes, walk up to
 * `pnpm-workspace.yaml` from this module's directory instead, which is
 * depth-independent. `bootstrap.test.ts` pins both the arithmetic and the fact
 * that the directory it lands on really is the workspace root.
 */
export const ROOT_ENV_FILE = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), ".env");

/**
 * Merges the repo-root `.env` into `process.env`, and returns the absolute
 * path of the file it read, or null if there is none.
 *
 * **Every key, not just `DATABASE_URL`.** This used to return immediately when
 * `DATABASE_URL` was already in the environment, which meant the one-off run
 * that matters most — `DATABASE_URL=postgres://…live… pnpm db:bootstrap` —
 * never saw the `SEED_OWNER_PASSWORD` the operator had put in `.env`, silently
 * fell back to the published default, and then printed that the password came
 * from the variable it had not read.
 *
 * `process.loadEnvFile` leaves keys that are already set alone, so an explicit
 * variable on the command line still wins over the file; the file only fills
 * the gaps.
 *
 * `envFile` exists for the tests, which need a temp file to merge from. Nothing
 * in any script passes it: the default is the only file this ever reads.
 */
export function loadRootEnv(envFile: string = ROOT_ENV_FILE): string | null {
  try {
    process.loadEnvFile(envFile);
  } catch {
    return null; // absent or unreadable — the process environment is all there is
  }
  return envFile;
}

/** Hostnames that are only ever this machine or this compose network. */
const LOCAL_HOSTNAMES = new Set(["localhost", "postgres", "db"]);

/** 10/8, 172.16/12, 192.168/16 (RFC 1918) and 127/8 (loopback). */
function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  const parsed = octets.map((octet) => (/^\d{1,3}$/.test(octet) ? Number(octet) : Number.NaN));
  if (parsed.some((octet) => Number.isNaN(octet) || octet > 255)) return false;
  const [first, second] = parsed as [number, number, number, number];
  if (first === 127 || first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  return first === 192 && second === 168;
}

/**
 * The eight 16-bit groups of an IPv6 address, or null if it is not one.
 * `new URL` already normalises a bracketed host to the canonical compressed
 * form, so this mostly re-expands `::`; it is written to accept the other
 * spellings too rather than depending on that.
 */
function ipv6Groups(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = toGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? toGroups(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"), ...tail];
  const parsed = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? Number.parseInt(group, 16) : Number.NaN));
  return parsed.some(Number.isNaN) ? null : parsed;
}

/**
 * IPv6 loopback in **any** spelling, an IPv4-mapped loopback or private
 * address (`::ffff:127.0.0.1`, which `new URL` serialises as `::ffff:7f00:1`),
 * and the unique-local range `fc00::/7` — a docker IPv6 network.
 *
 * Only two spellings used to be recognised, so a developer on an IPv6-only
 * docker network was told their database "is not a local host".
 */
function isLocalIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;
  const groups = ipv6Groups(hostname.split("%")[0]!); // drop a zone index: fe80::1%eth0
  if (!groups) return false;
  if (groups.every((group, index) => group === (index === 7 ? 1 : 0))) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    const octets = [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff];
    return isPrivateIpv4(octets.join("."));
  }
  return (groups[0]! & 0xfe00) === 0xfc00;
}

/**
 * True only when the connection string demonstrably points at this machine or
 * this compose network. Missing, unparseable, hostless (unix socket) and
 * multi-host URLs are false: an unknown target is treated as live.
 */
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  let hostname: string;
  try {
    // IPv6 hostnames come back bracketed; compare on the bare address.
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "") return false;
  return LOCAL_HOSTNAMES.has(hostname) || isPrivateIpv4(hostname) || isLocalIpv6(hostname);
}

/** The two variables the predicate reads. `NodeJS.ProcessEnv` satisfies it. */
export interface TargetEnv {
  NODE_ENV?: string | undefined;
  DATABASE_URL?: string | undefined;
}

/**
 * The predicate `seed.ts`'s demo-fixture guards are keyed on:
 * `NODE_ENV=production`, **or** a database that is not local. Nothing in
 * `bootstrap.ts` consults it — those guards are unconditional.
 *
 * Call it only after `loadRootEnv()`, so the `DATABASE_URL` it judges is the
 * one the run will actually connect to. Note that `.env` supplies `NODE_ENV`
 * like any other unset key, so a repo-root `.env` carrying
 * `NODE_ENV=production` does turn these guards on locally — the fail-safe
 * direction, and the converse cannot happen: unset and `development` are
 * identical here, and the file never overrides an exported variable.
 */
export function isProductionTarget(env: TargetEnv): boolean {
  if (env.NODE_ENV === "production") return true;
  return !isLocalDatabaseUrl(env.DATABASE_URL);
}

/**
 * Why a run was treated as production, for the refusal message. An operator
 * who did not set `NODE_ENV` needs to be told it was the host that decided.
 */
export function productionTargetReason(env: TargetEnv): string {
  if (env.NODE_ENV === "production") return "NODE_ENV=production";
  return "the database this run is pointed at is not a local host";
}
