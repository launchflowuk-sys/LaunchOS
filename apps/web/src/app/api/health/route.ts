import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "database unreachable";
    return Response.json({ ok: false, error: message }, { status: 503 });
  }
}
