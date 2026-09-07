import { listIncidents } from "@launchos/core";
import { getDb } from "@/lib/db";
import { authenticateApiRequest, callerMay, forbidden } from "@/lib/api/authenticate";
import { parseEnumParam, parsePaging } from "@/lib/api/paging";
import { apiError, apiOk } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

const STATUSES = ["open", "acknowledged", "resolved"] as const;

/** What is broken, whose it is, and how long it has been that way. */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  if (!callerMay(auth.caller, "support")) return forbidden("support");

  const params = new URL(request.url).searchParams;
  const paging = parsePaging(params);
  if (!paging.ok) return apiError("bad_request", paging.message);

  const status = parseEnumParam(params.get("status"), STATUSES);
  if (!status.ok) return apiError("bad_request", status.message);

  const generatedAt = new Date();
  const { incidents, total } = await listIncidents(
    getDb(),
    auth.caller.organisationId,
    { limit: paging.limit, offset: paging.offset, ...(status.value ? { status: status.value } : {}) },
    generatedAt,
  );

  return apiOk({ incidents, total }, {
    organisationId: auth.caller.organisationId,
    generatedAt: generatedAt.toISOString(),
  });
}
