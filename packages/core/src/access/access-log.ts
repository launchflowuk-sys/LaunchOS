import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { ACCESS_TARGET_TYPE } from "./access-entries.js";

export const ACCESS_LOG_LIMIT = 50;

/** One line of a client's access trail: who did what to which entry, when. */
export interface AccessLogRow {
  id: string;
  /** `client_access.created | updated | deleted | revealed`. */
  action: string;
  actorKind: string;
  actorId: string | null;
  /** The member's name, when the actor is a user who still exists. */
  actorName: string | null;
  entryId: string;
  /** The entry's label as it was at the time — still readable after the entry is deleted. */
  label: string | null;
  createdAt: Date;
}

/**
 * The last `limit` audit rows for one client's entries, newest first.
 *
 * Found through the `clientId` every entry action writes into its audit
 * payload rather than through the entries table, so a deleted entry's
 * history — including who revealed its password — stays on the client's
 * log after the row is gone.
 */
export async function accessLog(db: Db, organisationId: string, clientId: string, limit = ACCESS_LOG_LIMIT): Promise<AccessLogRow[]> {
  const a = schema.auditLog;
  const payloadClientId = sql<string | null>`coalesce(${a.after} ->> 'clientId', ${a.before} ->> 'clientId')`;
  return db
    .select({
      id: a.id,
      action: a.action,
      actorKind: a.actorKind,
      actorId: a.actorId,
      actorName: schema.user.name,
      entryId: a.targetId,
      label: sql<string | null>`coalesce(${a.after} ->> 'label', ${a.before} ->> 'label')`,
      createdAt: a.createdAt,
    })
    .from(a)
    .leftJoin(schema.user, eq(schema.user.id, a.actorId))
    .where(and(eq(a.organisationId, organisationId), eq(a.targetType, ACCESS_TARGET_TYPE), sql`${payloadClientId} = ${clientId}`))
    .orderBy(desc(a.createdAt), desc(a.id))
    .limit(limit);
}
