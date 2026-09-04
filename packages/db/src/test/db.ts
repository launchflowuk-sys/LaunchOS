import { createDb, type Db } from "../client.js";

const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL or DATABASE_URL_TEST must be set for tests");
const root = createDb(url);

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
