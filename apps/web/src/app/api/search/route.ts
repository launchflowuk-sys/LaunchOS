import { search, type SearchResults } from "@launchos/core";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const EMPTY: SearchResults = { clients: [], sites: [], domains: [], tickets: [], tasks: [] };
const MIN_QUERY_LENGTH = 2;

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < MIN_QUERY_LENGTH || q.length > 100) return NextResponse.json(EMPTY);

  const results = await search(getDb(), session.organisationId, { q });
  return NextResponse.json(results);
}
