import { schema } from "@launchos/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Section } from "@/components/section";
import { getDb } from "@/lib/db";
import { ReviewCard } from "./review-card";
import { CLIENT_REVIEW_ACTION } from "./schemas";

/**
 * Anything we have asked this client to look at.
 *
 * Matched on `payload->>'action'` rather than on `approvals.kind`: that is
 * already how `subscription_change` and the invoice send are identified — a
 * partial unique index cannot test an enum, so every approval that needs
 * finding writes `action` alongside `kind` — and it keeps this page working
 * whatever the enum value is eventually called. Both scope halves come from
 * the session, never from the page.
 *
 * The section renders nothing at all when there is nothing waiting. An empty
 * "Your approval" heading standing on a progress page is exactly the thing
 * this must not do: it reads as a job the client has not done.
 */

const MAX_SHOTS = 4;

type Shot = { url: string; label: string };

/**
 * The screenshots on the payload, if any. Written by whoever raised the
 * review, so it is read defensively — a malformed payload shows the note
 * without pictures rather than breaking a client's page.
 */
function screenshotsOf(payload: Record<string, unknown>): Shot[] {
  const raw = payload["screenshots"];
  if (!Array.isArray(raw)) return [];
  const shots: Shot[] = [];
  for (const entry of raw.slice(0, MAX_SHOTS)) {
    if (typeof entry === "string" && entry.startsWith("/")) {
      shots.push({ url: entry, label: "What we would like you to look at" });
      continue;
    }
    if (entry && typeof entry === "object") {
      const url = (entry as Record<string, unknown>)["url"];
      const label = (entry as Record<string, unknown>)["label"];
      if (typeof url === "string" && url.startsWith("/")) {
        shots.push({ url, label: typeof label === "string" ? label : "What we would like you to look at" });
      }
    }
  }
  return shots;
}

function noteOf(payload: Record<string, unknown>): string | null {
  const note = payload["note"] ?? payload["message"];
  return typeof note === "string" && note.trim().length > 0 ? note : null;
}

export async function ClientReviews({ organisationId, clientId }: { organisationId: string; clientId: string }) {
  const rows = await getDb()
    .select({ id: schema.approvals.id, title: schema.approvals.title, payload: schema.approvals.payload })
    .from(schema.approvals)
    .where(and(
      eq(schema.approvals.organisationId, organisationId),
      eq(schema.approvals.status, "pending"),
      isNull(schema.approvals.deletedAt),
      sql`${schema.approvals.payload} ->> 'action' = ${CLIENT_REVIEW_ACTION}`,
      sql`${schema.approvals.payload} ->> 'clientId' = ${clientId}`,
    ))
    .orderBy(asc(schema.approvals.createdAt));

  if (rows.length === 0) return null;

  return (
    <Section
      title={rows.length === 1 ? "One thing to look at" : `${rows.length} things to look at`}
      description="An invitation, not a hold-up. Have a look when it suits you — the build carries on regardless."
    >
      <div className="grid gap-3">
        {rows.map((row) => (
          <ReviewCard
            key={row.id}
            approvalId={row.id}
            title={row.title}
            note={noteOf(row.payload)}
            screenshots={screenshotsOf(row.payload)}
          />
        ))}
      </div>
    </Section>
  );
}
