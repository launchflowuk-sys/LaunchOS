import { listClients } from "@launchos/core";
import { getDb } from "@/lib/db";
import { authenticateApiRequest, callerMay, forbidden } from "@/lib/api/authenticate";
import { parseEnumParam, parsePaging } from "@/lib/api/paging";
import { apiError, apiOk } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

const STATUSES = ["active", "paused", "archived"] as const;

/**
 * The client roster.
 *
 * Gated on `support`, which is **stricter than the admin** — the sidebar shows
 * Clients to any signed-in member with no permission at all. That difference is
 * deliberate: an admin session is a person who has already authenticated as
 * themselves, while a token is a key that might be sitting on a lost laptop, so
 * it starts able to read nothing and is granted areas one at a time.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  if (!callerMay(auth.caller, "support")) return forbidden("support");

  const params = new URL(request.url).searchParams;
  const paging = parsePaging(params);
  if (!paging.ok) return apiError("bad_request", paging.message);

  const status = parseEnumParam(params.get("status"), STATUSES);
  if (!status.ok) return apiError("bad_request", status.message);

  const query = params.get("q")?.trim() || undefined;
  const generatedAt = new Date();
  const clients = await listClients(getDb(), auth.caller.organisationId, {
    limit: paging.limit,
    offset: paging.offset,
    ...(status.value ? { status: status.value } : {}),
    ...(query ? { query } : {}),
    // A person scanning for a name wants the alphabet; that is what this list
    // is for, and it is `listClients`' own default.
    order: "name",
  });

  return apiOk({ clients }, {
    organisationId: auth.caller.organisationId,
    generatedAt: generatedAt.toISOString(),
  });
}
