import { createDb, type Db } from "../client.js";

const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL or DATABASE_URL_TEST must be set for tests");

/**
 * A deliberately small pool, and one that lets go.
 *
 * Vitest gives each test file its own module registry, so each one builds its
 * own client — and a serving process's ten connections, held forever, is the
 * wrong shape entirely for that. Against `max_connections = 100`, a hundred-odd
 * files across several workers exhausted the server, and the failure arrived as
 * a `provider timeout` on whichever test happened to be running: a different
 * one each time, always passing on its own, which is what made it look flaky
 * rather than like the resource problem it was.
 *
 * A test worker runs one test at a time and `withTestDb` holds exactly one
 * transaction, so **one** connection is the honest number. The spare second one
 * doubled the whole run's footprint for nothing, and adding a single new test
 * file was enough to bring the exhaustion back — as a stripe-sync assertion
 * failing, which is the tell: a different test each time, always passing alone.
 *
 * An idle connection is given back after five seconds rather than held to the
 * end of the run.
 */
const root = createDb(url, { max: 1, idleTimeout: 5 });

class Rollback extends Error {}

/** Runs fn inside a transaction that is always rolled back. */
export async function withTestDb(fn: (db: Db) => Promise<void>): Promise<void> {
  try {
    await root.transaction(async (tx) => {
      await fn(tx as unknown as Db);
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}
