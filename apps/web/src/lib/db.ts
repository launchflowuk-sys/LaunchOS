import { createDb, type Db } from "@launchos/db";

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
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  cached = createDb(url);
  return cached;
}
