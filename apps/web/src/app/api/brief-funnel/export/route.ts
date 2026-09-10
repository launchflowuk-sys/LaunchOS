import { schema } from "@launchos/db";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * A brief, downloaded.
 *
 * **Staff only.** Everything else under `/api/brief-funnel` is public and
 * authorised by the draft's cookie; this one is not, and is scoped to the
 * signed-in user's organisation. A customer's own copy is a different door and
 * is not this one.
 *
 * The filename is built from the reference and nothing else — a business name
 * is somebody's typing, and typing in a `Content-Disposition` header is how a
 * newline ends up splitting a response.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await requireAdmin();
  const url = new URL(request.url);
  const submissionId = url.searchParams.get("submission") ?? "";
  const format = url.searchParams.get("format") === "json" ? "json" : "md";

  const [submission] = await getDb()
    .select()
    .from(schema.briefSubmissions)
    .where(
      and(
        eq(schema.briefSubmissions.id, submissionId),
        eq(schema.briefSubmissions.organisationId, session.organisationId),
      ),
    );
  if (!submission) return new Response("Not found", { status: 404 });

  const [version] = await getDb()
    .select()
    .from(schema.briefVersions)
    .where(eq(schema.briefVersions.submissionId, submission.id))
    .orderBy(desc(schema.briefVersions.version));
  if (!version) return new Response("Not found", { status: 404 });

  // `LF-XXXX-XXXX` is already a safe filename; the guard is here so it stays
  // one if the reference format ever changes.
  const name = `${submission.reference.replace(/[^A-Za-z0-9-]/g, "")}.${format}`;
  const body = format === "json"
    ? JSON.stringify({ reference: submission.reference, answers: submission.answers, brief: version.structured }, null, 2)
    : version.markdown;

  return new Response(body, {
    headers: {
      "content-type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}
