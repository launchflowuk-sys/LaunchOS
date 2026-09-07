import { listInvoices } from "@launchos/core";
import { getDb } from "@/lib/db";
import { authenticateApiRequest, callerMay, forbidden } from "@/lib/api/authenticate";
import { parseEnumParam, parsePaging } from "@/lib/api/paging";
import { apiError, apiOk } from "@/lib/api/respond";

export const dynamic = "force-dynamic";

const STATUSES = ["draft", "sent", "paid", "overdue", "void"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Money owed and money in, in pence.
 *
 * `totalPenceMatching` sums every invoice the filter matched rather than the
 * page returned, because "how much am I owed" is the actual question and an
 * assistant adding up one page would answer it confidently and wrongly.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  if (!callerMay(auth.caller, "billing")) return forbidden("billing");

  const params = new URL(request.url).searchParams;
  const paging = parsePaging(params);
  if (!paging.ok) return apiError("bad_request", paging.message);

  const status = parseEnumParam(params.get("status"), STATUSES);
  if (!status.ok) return apiError("bad_request", status.message);

  // Checked here rather than left to Zod inside the service: a malformed id
  // should be a 400 that says so, not a 500 from a parse deeper down.
  const clientId = params.get("clientId")?.trim() || undefined;
  if (clientId !== undefined && !UUID.test(clientId)) {
    return apiError("bad_request", "clientId must be a uuid");
  }

  const generatedAt = new Date();
  const result = await listInvoices(
    getDb(),
    auth.caller.organisationId,
    { limit: paging.limit, offset: paging.offset, ...(status.value ? { status: status.value } : {}), ...(clientId ? { clientId } : {}) },
    generatedAt,
  );

  return apiOk(result, {
    organisationId: auth.caller.organisationId,
    generatedAt: generatedAt.toISOString(),
  });
}
