import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export interface DbOptions {
  /** Connections this client may hold. Ten suits a serving process. */
  max?: number;
  /** Seconds an unused connection is kept. Zero, the default, keeps it forever. */
  idleTimeout?: number;
}

export type Db = ReturnType<typeof createDb>;

export function createDb(url: string, options: DbOptions = {}) {
  const sql = postgres(url, {
    max: options.max ?? 10,
    prepare: false,
    ...(options.idleTimeout === undefined ? {} : { idle_timeout: options.idleTimeout }),
  });
  return drizzle(sql, { schema, casing: "snake_case" });
}
