import { listLeads } from "@launchos/core";
import { getDb } from "@/lib/db";
import { authenticateApiRequest, callerMay, forbidden } from "@/lib/api/authenticate";
import { parseEnumParam, parsePaging } from "@/lib/api/paging";
import { apiError, apiOk } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

const STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;

/**
 * Enquiries, newest first.
 *
 * Under `support` rather than a scope of its own: a lead is somebody waiting
 * for a reply, which is the same job as a case, and the morning brief already
 * counts them there. Two vocabularies for one idea is how they drift.
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

  const generatedAt = new Date();
  const { leads, total } = await listLeads(getDb(), auth.caller.organisationId, {
    limit: paging.limit,
    offset: paging.offset,
    ...(status.value ? { status: status.value } : {}),
  });

  return apiOk({ leads, total }, {
    organisationId: auth.caller.organisationId,
    generatedAt: generatedAt.toISOString(),
  });
}
