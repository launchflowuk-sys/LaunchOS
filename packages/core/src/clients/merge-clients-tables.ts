import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { getTableName, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/**
 * Every table that points at a client, and how its rows move from one
 * client to another. Enumerated from the schema by hand — a new table with a
 * `client_id` belongs in `MOVE_SPECS` — and checked by the merge test, which
 * asserts nothing still references the merged client afterwards.
 *
 * A table whose rows are unique per client (one brief per client, one task
 * per template, one portal user per person) moves only the rows the kept
 * client does not already have; the rest are left on the archived client
 * (`left`) or, where the duplicate is meaningless, deleted (`dropped`).
 * Rows that follow a moved row through their own foreign key — messages
 * under a conversation, monitors and credentials under a site, DNS records
 * under a domain, metric snapshots under an ad account — need nothing done.
 */

export interface MoveSpec {
  /** The key the counts are reported under: the table name. */
  key: string;
  table: PgTable;
  /**
   * When the kept client already has a row that would collide with the
   * candidate row `t`, in SQL over aliases `t` (the row to move) and `k`
   * (the kept client's rows). Absent means rows never collide.
   */
  conflict?: SQL;
  /** What to do with a colliding row: leave it on the archived client, or delete it. */
  onConflict?: "leave" | "drop";
}

export const MOVE_SPECS: readonly MoveSpec[] = [
  { key: "client_contacts", table: schema.clientContacts },
  { key: "client_payment_accounts", table: schema.clientPaymentAccounts },
  { key: "subscriptions", table: schema.subscriptions },
  { key: "invoices", table: schema.invoices },
  { key: "payments", table: schema.payments },
  { key: "sites", table: schema.sites },
  { key: "domains", table: schema.domains },
  { key: "client_access_entries", table: schema.clientAccessEntries },
  { key: "conversations", table: schema.conversations },
  { key: "tickets", table: schema.tickets },
  {
    key: "tasks", table: schema.tasks, onConflict: "leave",
    conflict: sql`(k.template_id = t.template_id and t.phase = 'onboarding' and k.phase = 'onboarding') or k.recurrence_key = t.recurrence_key`,
  },
  { key: "activity_events", table: schema.activityEvents },
  { key: "meetings", table: schema.meetings },
  { key: "leads", table: schema.leads },
  { key: "ad_accounts", table: schema.adAccounts },
  { key: "content_briefs", table: schema.contentBriefs, conflict: sql`true`, onConflict: "leave" },
  { key: "content_channels", table: schema.contentChannels, conflict: sql`k.channel = t.channel`, onConflict: "leave" },
  {
    key: "content_items", table: schema.contentItems, onConflict: "leave",
    conflict: sql`k.period_key = t.period_key and k.channel = t.channel and (k.metadata ->> 'slot') = (t.metadata ->> 'slot')`,
  },
  { key: "content_assets", table: schema.contentAssets },
  // A merged client's proposals, signed copies and invoices follow them, and
  // never collide: a document is written once and is unique by construction.
  { key: "documents", table: schema.documents },
  // Proposals move whole. Their lines and acceptances carry no `client_id` of
  // their own — they hang off the proposal — so they need no spec here and
  // follow it across without being touched.
  { key: "proposals", table: schema.proposals },
  { key: "content_reports", table: schema.contentReports, conflict: sql`k.period_key = t.period_key`, onConflict: "leave" },
  { key: "client_reports", table: schema.clientReports, conflict: sql`k.period_start = t.period_start`, onConflict: "leave" },
  { key: "client_users", table: schema.clientUsers, conflict: sql`k.user_id = t.user_id`, onConflict: "drop" },
  // One support address per client, and the kept client keeps its own: the
  // duplicate's identity is retired. Its `clients.support_email` stays on the
  // archived row (it is globally unique), so nobody else can be given it.
  { key: "email_identities", table: schema.emailIdentities, conflict: sql`true`, onConflict: "drop" },
];

/** `billing_profiles` is handled by hand in `merge-clients.ts` and so is not in `MOVE_SPECS`. */
export const HAND_MERGED_TABLES: readonly string[] = ["billing_profiles"];

export interface MoveCounts {
  /** Rows on the merged client that move (or, after the fact, moved) to the kept one. */
  moved: number;
  /** Rows left on the archived client because the kept one already has their equivalent. */
  left: number;
  /** Duplicate rows deleted because the kept client already has the same thing. */
  dropped: number;
}

interface MergePair {
  organisationId: string;
  keepId: string;
  mergeId: string;
}

function collides(spec: MoveSpec, pair: MergePair): SQL {
  if (!spec.conflict) return sql`false`;
  const table = sql.raw(`"${getTableName(spec.table)}"`);
  return sql`exists (select 1 from ${table} k where k.client_id = ${pair.keepId} and (${spec.conflict}))`;
}

/** What moving one table would do, without writing. */
export async function countMove(db: Db, spec: MoveSpec, pair: MergePair): Promise<MoveCounts> {
  const table = sql.raw(`"${getTableName(spec.table)}"`);
  const rows = await db.execute<{ total: string | number; blocked: string | number }>(sql`
    select count(*) as total, count(*) filter (where ${collides(spec, pair)}) as blocked
    from ${table} t
    where t.organisation_id = ${pair.organisationId} and t.client_id = ${pair.mergeId}
  `);
  const total = Number(rows[0]?.total ?? 0);
  const blocked = Number(rows[0]?.blocked ?? 0);
  return {
    moved: total - blocked,
    left: spec.onConflict === "drop" ? 0 : blocked,
    dropped: spec.onConflict === "drop" ? blocked : 0,
  };
}

/** Moves one table's rows, deleting the duplicates the spec says to. Returns what happened. */
export async function applyMove(db: Db, spec: MoveSpec, pair: MergePair): Promise<MoveCounts> {
  const table = sql.raw(`"${getTableName(spec.table)}"`);
  const scope = sql`t.organisation_id = ${pair.organisationId} and t.client_id = ${pair.mergeId}`;
  const dropped = spec.onConflict === "drop"
    ? (await db.execute<{ id: string }>(sql`delete from ${table} t where ${scope} and ${collides(spec, pair)} returning t.id`)).length
    : 0;
  const moved = (await db.execute<{ id: string }>(sql`
    update ${table} t set client_id = ${pair.keepId}, updated_at = now()
    where ${scope} and not ${collides(spec, pair)}
    returning t.id
  `)).length;
  const left = (await db.execute<{ n: string | number }>(sql`select count(*) as n from ${table} t where ${scope}`))[0]?.n ?? 0;
  return { moved, left: Number(left), dropped };
}
