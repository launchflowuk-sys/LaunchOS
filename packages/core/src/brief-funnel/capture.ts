import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { ATTRIBUTION_METADATA_KEY, attributionSummary, hasAttribution } from "../leads/attribution.js";
import { notifyOwner } from "../notifications/notify.js";
import {
  attributionFromSessionSource,
  LATEST_ATTRIBUTION_METADATA_KEY,
  latestAttributionFromSessionSource,
} from "./lead-attribution.js";

/**
 * Turning a half-filled form into somebody we can ring.
 *
 * This is the reason the funnel was rebuilt. The old form created nothing until
 * the last screen, so a plumber who typed his name and number and then got a
 * call-out left no trace at all. Here the lead is written **the moment there is
 * a valid email or phone** — before the first step is finished, before Continue
 * is pressed, before we know anything else about them.
 *
 * A name and an address are not a lead. They are a draft. Nobody can be
 * contacted with them, and creating a `leads` row we cannot act on just fills
 * the board with things that look like work.
 */

/** Trimmed to what the lead actually needs; the rest of the answers stay on the draft. */
export const ContactFields = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  phone: z.string().trim().min(6).max(40).optional(),
  business: z.string().trim().max(200).optional(),
});
export type ContactFields = z.input<typeof ContactFields>;

/**
 * Whether these details are enough to reach somebody.
 *
 * Either one will do. Insisting on email would lose the tradesman who gives a
 * mobile and nothing else, and he is exactly the customer this funnel is for.
 */
export function isContactable(fields: z.output<typeof ContactFields>): boolean {
  return Boolean(fields.email) || Boolean(fields.phone);
}

export interface LeadCaptureResult {
  leadId: string | null;
  /** True only on the write that first created the lead — what the owner's bell keys off. */
  created: boolean;
}

/**
 * Attaches a lead to a draft, or updates the one already attached.
 *
 * Idempotent by construction: the draft's `lead_id` is the record of whether
 * this has happened, and it is read and written inside the same transaction, so
 * two debounced saves landing together produce one lead rather than two.
 *
 * Deliberately never merges into an existing lead that happens to share an
 * email. Two people at one company, or one person starting again six months
 * later, are two enquiries — and quietly writing a stranger's answers into an
 * existing record would show them somebody else's project.
 */
export async function captureLeadFromDraft(
  db: Db,
  organisationId: string,
  sessionId: string,
  fields: ContactFields,
): Promise<LeadCaptureResult> {
  const v = ContactFields.parse(fields);

  const outcome = await db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(schema.briefSessions)
      .where(and(eq(schema.briefSessions.id, sessionId), eq(schema.briefSessions.organisationId, organisationId)));
    if (!session) throw new Error("that draft could not be found");

    const attribution = attributionFromSessionSource(session.source);
    const latest = latestAttributionFromSessionSource(session.source);

    if (session.leadId) {
      // Already captured. Keep the lead in step with what they have since
      // corrected — a typo'd email fixed on the second screen has to reach the
      // record we would actually reply to.
      //
      // The latest touch is refreshed here too, because a person who comes
      // back on a second ad and then types their number is a second touch we
      // only learn about on this write. The original attribution is never
      // touched: it is read from the draft once, at creation, and after that
      // it is history.
      const [existing] = await tx
        .select({ metadata: schema.leads.metadata })
        .from(schema.leads)
        .where(and(eq(schema.leads.id, session.leadId), eq(schema.leads.organisationId, organisationId)));

      await tx
        .update(schema.leads)
        .set({
          ...(v.name ? { name: v.name } : {}),
          ...(v.email ? { email: v.email } : {}),
          ...(v.phone ? { phone: v.phone } : {}),
          ...(v.business ? { business: v.business } : {}),
          ...(existing && hasAttribution(latest)
            ? { metadata: { ...existing.metadata, [LATEST_ATTRIBUTION_METADATA_KEY]: latest } }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.leads.id, session.leadId), eq(schema.leads.organisationId, organisationId)));
      return { leadId: session.leadId, created: false, attribution };
    }

    if (!isContactable(v)) return { leadId: null, created: false, attribution };

    const [lead] = await tx
      .insert(schema.leads)
      .values({
        organisationId,
        // A lead has to be called something. Their own words if we have them,
        // the business if not, and a plain placeholder rather than an empty
        // string that renders as a blank row on the board.
        name: v.name ?? v.business ?? "Website enquiry",
        ...(v.email ? { email: v.email } : {}),
        ...(v.phone ? { phone: v.phone } : {}),
        ...(v.business ? { business: v.business } : {}),
        source: "brief-funnel",
        status: "new",
        // The campaign that brought them, carried across from the draft. Every
        // funnel lead before this stored nothing here, so the leads board, the
        // campaign filter and cost-per-lead all showed the funnel as a blank.
        metadata: {
          ...(hasAttribution(attribution) ? { [ATTRIBUTION_METADATA_KEY]: attribution } : {}),
          ...(hasAttribution(latest) ? { [LATEST_ATTRIBUTION_METADATA_KEY]: latest } : {}),
        },
      })
      .returning();

    await tx
      .update(schema.briefSessions)
      .set({ leadId: lead!.id, updatedAt: new Date() })
      .where(and(eq(schema.briefSessions.id, sessionId), eq(schema.briefSessions.organisationId, organisationId)));

    await recordAudit(tx as unknown as Db, organisationId, {
      actorKind: "system",
      action: "lead.captured",
      targetType: "lead",
      targetId: lead!.id,
      after: { source: "brief-funnel", contactable: true, attribution },
    });

    return { leadId: lead!.id, created: true, attribution };
  });

  // Outside the transaction: the bell is a nicety and must never be the reason
  // a captured lead rolls back.
  const campaign = attributionSummary(outcome.attribution);
  if (outcome.created && outcome.leadId) {
    await notifyOwner(db, organisationId, {
      kind: "lead.captured",
      title: `New enquiry: ${v.name ?? v.business ?? "someone"}`,
      body:
        `${v.email ?? v.phone} — started a website brief. They may not have finished it.` +
        // The campaign, on the bell itself. `createLead` has said this since
        // the contact form was built; a funnel lead said nothing, so the one
        // enquiry that cost money to win was the one that looked organic.
        (campaign ? `\nCampaign: ${campaign}` : ""),
      link: `/leads/${outcome.leadId}`,
    }).catch(() => undefined);
  }

  return { leadId: outcome.leadId, created: outcome.created };
}
