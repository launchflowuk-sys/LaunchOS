/**
 * What "production" means to the two scripts that can write a credential.
 *
 * `NODE_ENV` is a statement of intent, and the failure that matters is the one
 * where nobody made that statement: a one-off run against a live database from
 * a restore box, a maintenance container or a laptop, in a shell where
 * `NODE_ENV` was never exported. The guards that stop a published password or
 * an unconfirmed slug reaching a live tenant must not be skippable by
 * forgetting a variable.
 *
 * So the target is what decides. A run is a **production target** unless the
 * database it is pointed at is demonstrably local:
 *
 * - `localhost`, `127.0.0.1` (any `127.x` loopback) or `::1`;
 * - `postgres` or `db`, the docker-compose service names this repo ships;
 * - an RFC1918 address (`10/8`, `172.16/12`, `192.168/16`), which is a docker
 *   bridge or a LAN box, not a hosted database.
 *
 * Everything else — a public hostname, a Coolify service address, an
 * unparseable or missing URL — is treated as production. Erring that way costs
 * a developer one environment variable; erring the other way installs a
 * password printed in this repository on a live tenant.
 *
 * `NODE_ENV=production` still forces production on, so nothing that was
 * guarded before is guarded less now.
 */

/** Hostnames that are only ever this machine or this compose network. */
const LOCAL_HOSTNAMES = new Set(["localhost", "postgres", "db", "::1", "0:0:0:0:0:0:0:1"]);

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
 * True only when the connection string demonstrably points at this machine or
 * this compose network. Missing, unparseable or socket-only URLs are false:
 * an unknown target is treated as live.
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
  return LOCAL_HOSTNAMES.has(hostname) || isPrivateIpv4(hostname);
}

/** The two variables the predicate reads. `NodeJS.ProcessEnv` satisfies it. */
export interface TargetEnv {
  NODE_ENV?: string | undefined;
  DATABASE_URL?: string | undefined;
}

/**
 * The predicate every production guard in `bootstrap.ts` and `seed.ts` is
 * keyed on: `NODE_ENV=production`, **or** a database that is not local.
 *
 * Call it only after `loadRootEnv()`, so the `DATABASE_URL` it judges is the
 * one the run will actually connect to.
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
