import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch (error) {
    // This endpoint is unauthenticated, so the driver error never reaches the
    // caller: postgres.js messages carry the host, user and role names.
    console.error("[health] database check failed", error);
    return Response.json({ ok: false }, { status: 503 });
  }
}
