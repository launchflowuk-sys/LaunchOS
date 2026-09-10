import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import type { SiteBrief } from "@launchos/integrations";
import { and, eq } from "drizzle-orm";
import { LeadQualification } from "../leads/qualification.js";

/**
 * Turning what a lead told us into a brief a model can build from.
 *
 * This is the join the whole chain rests on. The wizard asks the questions, the
 * answers land in `leads.qualification`, and this is where they become the
 * prompt — no retyping, no phone call, no person in the middle deciding what to
 * paste.
 *
 * It refuses rather than guesses. A lead who gave a name and closed the tab has
 * no services, no area and no goals, and a site generated from that would be
 * three paragraphs of invention on somebody's real business. Better to say the
 * brief is too thin and let a person fill the gaps.
 */

export class BriefTooThin extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`the lead has not said enough to build from: no ${missing.join(", no ")}`);
    this.name = "BriefTooThin";
  }
}

/**
 * The least a site can honestly be built from.
 *
 * A business name and *something* about what they do. Without the second, the
 * model has nothing to write about and fills the space itself — which is how a
 * plumber ends up with a page claiming twenty years of experience nobody
 * mentioned.
 */
export function missingFromBrief(qualification: LeadQualification, businessName: string | null): string[] {
  const missing: string[] = [];
  if (!businessName?.trim()) missing.push("business name");
  if (!qualification.services?.trim() && !qualification.industry?.trim()) missing.push("services or industry");
  return missing;
}

export interface LeadBriefResult {
  brief: SiteBrief;
  leadId: string;
}

/** The brief for one lead, or a refusal naming what is missing. */
export async function briefFromLead(db: Db, organisationId: string, leadId: string): Promise<LeadBriefResult> {
  const [lead] = await db
    .select({
      id: schema.leads.id,
      name: schema.leads.name,
      business: schema.leads.business,
      qualification: schema.leads.qualification,
    })
    .from(schema.leads)
    .where(and(eq(schema.leads.id, leadId), eq(schema.leads.organisationId, organisationId)));
  if (!lead) throw new Error("that lead could not be found");

  // Parsed rather than cast: the column is jsonb and an older row may predate a
  // field. Unknown keys are dropped, missing ones stay undefined.
  const parsed = LeadQualification.safeParse(lead.qualification ?? {});
  const qualification: LeadQualification = parsed.success ? parsed.data : {};

  // The business name, or the person's own name — a sole trader often gives one
  // and means the other.
  const businessName = lead.business?.trim() || lead.name?.trim() || null;

  const missing = missingFromBrief(qualification, businessName);
  if (missing.length > 0) throw new BriefTooThin(missing);

  return {
    leadId: lead.id,
    brief: {
      businessName: businessName!,
      ...(qualification.industry ? { industry: qualification.industry } : {}),
      ...(qualification.services ? { services: qualification.services } : {}),
      ...(qualification.serviceArea ? { serviceArea: qualification.serviceArea } : {}),
      ...(qualification.goals ? { goals: qualification.goals } : {}),
      ...(qualification.websiteUrl ? { existingUrl: qualification.websiteUrl } : {}),
    },
  };
}
