import { createDb, type Db } from "@launchos/db";

/**
 * `next dev` re-evaluates a module every time something it imports is
 * recompiled, so a plain module-scope cache creates a fresh Postgres pool on
 * each edit and leaks the old one's connections until the server runs out
 * (~94 of 100 observed locally). Caching on `globalThis`, which survives module
 * re-evaluation, keeps exactly one pool per dev process. Production never
 * recompiles, so it keeps the plain module-scope cache and identical behaviour.
 */
const globalForDb = globalThis as typeof globalThis & { __launchosDb?: Db };

let cached: Db | undefined;

/**
 * The database client, created on first use and cached for the process.
 *
 * Lazy on purpose: `next build` imports every route module to collect page
 * data, and the build environment (Docker, CI) has no DATABASE_URL. Throwing
 * at call time instead of import time keeps the build green while still
 * failing loudly on the first request that needs the database.
 */
export function getDb(): Db {
  const existing = cached ?? (process.env.NODE_ENV === "production" ? undefined : globalForDb.__launchosDb);
  if (existing) {
    cached = existing;
    return existing;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  cached = createDb(url);
  if (process.env.NODE_ENV !== "production") globalForDb.__launchosDb = cached;
  return cached;
}
