import { listApprovals } from "@launchos/core";
import { getDb } from "@/lib/db";
import { authenticateApiRequest, callerMay, forbidden } from "@/lib/api/authenticate";
import { parseEnumParam, parsePaging } from "@/lib/api/paging";
import { apiError, apiOk } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

const STATUSES = ["pending", "approved", "rejected"] as const;

/**
 * What is waiting on a human.
 *
 * Read-only, and it stays that way. Deciding an approval is the one act the
 * whole agent design exists to keep in a person's hands (CLAUDE.md rule 2) —
 * exposing a decision endpoint here would hand it to whatever holds the token.
 * `listApprovals` also withholds the payload, so the actual outward message or
 * DNS change is never returned; see that function for why.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  if (!callerMay(auth.caller, "approvals")) return forbidden("approvals");

  const params = new URL(request.url).searchParams;
  const paging = parsePaging(params);
  if (!paging.ok) return apiError("bad_request", paging.message);

  const status = parseEnumParam(params.get("status"), STATUSES);
  if (!status.ok) return apiError("bad_request", status.message);

  const generatedAt = new Date();
  const { approvals, total } = await listApprovals(
    getDb(),
    auth.caller.organisationId,
    { limit: paging.limit, offset: paging.offset, ...(status.value ? { status: status.value } : {}) },
    generatedAt,
  );

  return apiOk({ approvals, total }, {
    organisationId: auth.caller.organisationId,
    generatedAt: generatedAt.toISOString(),
  });
}
