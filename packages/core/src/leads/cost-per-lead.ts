import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, count, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { campaignSpend } from "../ads/campaigns.js";
import { ATTRIBUTION_METADATA_KEY } from "./attribution.js";

/**
 * What an enquiry costs, campaign by campaign.
 *
 * Two sides that were never designed to meet: a lead carries whatever
 * `utm_campaign` the ad's landing URL happened to set, and the ad platforms
 * report spend against a campaign they name themselves. They meet on the name,
 * normalised — trimmed, lower-cased, and with spaces and underscores read as
 * hyphens, because "Spring Offer", "spring_offer" and "spring-offer" are one
 * campaign to everyone except a string comparison.
 *
 * **The honesty rules, which are the point of this file.**
 *
 * 1. A lead with no campaign is never folded into a campaign. It gets its own
 *    row, `campaign: null`, and no cost per lead — not a zero.
 * 2. Spend with no leads gets its own row too. An ad that took money and
 *    produced nothing is the single most useful line on this screen.
 * 3. A campaign with leads and no matched spend shows a cost per lead of
 *    `null`, never zero. Zero would read as "free".
 * 4. The result carries `attributedLeads` / `totalLeads` and
 *    `placedSpendPence` / `accountSpendPence` so the screen can say, in a
 *    sentence, how much of the picture this is. A confident number over half
 *    the data is worse than an obviously partial one.
 */

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be an ISO calendar date");

export const CostPerLeadInput = z.object({
  /** Inclusive ISO calendar dates, in the reporting day the ad platforms use. */
  from: IsoDate,
  to: IsoDate,
  /** One client's campaigns and their leads. Omitted, the whole organisation. */
  clientId: z.string().uuid().optional(),
});
export type CostPerLeadInput = z.input<typeof CostPerLeadInput>;

export interface CampaignCostPerLead {
  /** The campaign as the leads spell it, or as the platform does when only spend matched. Null is "no campaign". */
  campaign: string | null;
  leads: number;
  converted: number;
  /** Null when no ad spend matched this campaign — not zero. */
  spendPence: number | null;
  /** Pence per lead, rounded. Null when either side is missing. */
  costPerLeadPence: number | null;
  clicks: number | null;
}

export interface CostPerLeadReport {
  from: string;
  to: string;
  rows: CampaignCostPerLead[];
  totalLeads: number;
  /** Leads carrying a `utm_campaign`. The numerator of the coverage sentence. */
  attributedLeads: number;
  /** Leads whose campaign also matched ad spend. Always `<= attributedLeads`. */
  matchedLeads: number;
  /** Every active ad account's spend over the period. */
  accountSpendPence: number;
  /** The part of it that landed on a campaign row. */
  placedSpendPence: number;
}

/** "Spring Offer" and "spring_offer" are the same campaign; a comparison should agree. */
export function normaliseCampaign(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

interface LeadCampaignRow {
  campaign: string | null;
  leads: number;
  converted: number;
}

/** Leads in the window grouped by their raw `utm_campaign`, the null row included. */
async function leadsByCampaign(db: Db, organisationId: string, from: Date, to: Date, clientId?: string): Promise<LeadCampaignRow[]> {
  // A literal path, not a parameter: Postgres wants the GROUP BY expression to
  // be textually identical to the selected one, and two `$n` placeholders are
  // not. Same reason `leadCampaignCounts` writes it this way.
  const campaign = sql<string | null>`${schema.leads.metadata}->${sql.raw(`'${ATTRIBUTION_METADATA_KEY}'`)}->>'utmCampaign'`;
  const rows = await db
    .select({
      campaign,
      leads: count(),
      converted: sql<number>`count(*) filter (where ${schema.leads.status} = 'converted')`,
    })
    .from(schema.leads)
    .where(and(
      eq(schema.leads.organisationId, organisationId),
      isNull(schema.leads.deletedAt),
      gte(schema.leads.createdAt, from),
      lte(schema.leads.createdAt, to),
      clientId ? eq(schema.leads.clientId, clientId) : undefined,
    ))
    .groupBy(campaign);
  return rows.map((row) => ({ campaign: row.campaign, leads: Number(row.leads), converted: Number(row.converted) }));
}

/** The window as instants: `from` at 00:00 and `to` at 23:59:59.999, UTC — the day the ad platforms report in. */
function windowOf(from: string, to: string): { start: Date; end: Date } {
  return { start: new Date(`${from}T00:00:00.000Z`), end: new Date(`${to}T23:59:59.999Z`) };
}

/**
 * Leads, spend and cost per lead by campaign over a period, biggest spend
 * first, then most leads, with the unattributed row last wherever it lands.
 */
export async function costPerLeadByCampaign(db: Db, organisationId: string, input: CostPerLeadInput): Promise<CostPerLeadReport> {
  const v = CostPerLeadInput.parse(input);
  if (v.from > v.to) throw new Error("the period starts after it ends");
  const { start, end } = windowOf(v.from, v.to);

  const [leadRows, spend] = await Promise.all([
    leadsByCampaign(db, organisationId, start, end, v.clientId),
    campaignSpend(db, organisationId, { from: v.from, to: v.to, ...(v.clientId ? { clientId: v.clientId } : {}) }),
  ]);

  // Keyed on the normalised name; the label kept is the one the leads used,
  // because that is the string Shoji typed into the ad's landing URL and the
  // one he will search for.
  interface Bucket { label: string; leads: number; converted: number; spendPence: number | null; clicks: number | null }
  const buckets = new Map<string, Bucket>();
  let attributedLeads = 0;
  let totalLeads = 0;
  // Counted separately rather than kept in `buckets`: a lead with no campaign
  // must never be able to collide with a campaign called anything.
  let unattributedLeads = 0;
  let unattributedConverted = 0;

  for (const row of leadRows) {
    totalLeads += row.leads;
    if (row.campaign === null || row.campaign.trim() === "") {
      unattributedLeads += row.leads;
      unattributedConverted += row.converted;
      continue;
    }
    attributedLeads += row.leads;
    const key = normaliseCampaign(row.campaign);
    const existing = buckets.get(key);
    buckets.set(key, {
      label: existing?.label ?? row.campaign.trim(),
      leads: (existing?.leads ?? 0) + row.leads,
      converted: (existing?.converted ?? 0) + row.converted,
      spendPence: existing?.spendPence ?? null,
      clicks: existing?.clicks ?? null,
    });
  }

  let placedSpendPence = 0;
  for (const row of spend.campaigns) {
    const key = normaliseCampaign(row.campaignName);
    const existing = buckets.get(key);
    buckets.set(key, {
      label: existing?.label ?? row.campaignName.trim(),
      leads: existing?.leads ?? 0,
      converted: existing?.converted ?? 0,
      spendPence: (existing?.spendPence ?? 0) + row.spendPence,
      clicks: (existing?.clicks ?? 0) + row.clicks,
    });
    // "Placed" means matched to leads we can see. Spend on a campaign nobody
    // enquired from is still reported as its own row, but it does not count
    // towards the share of the budget this screen has joined up.
    if ((existing?.leads ?? 0) > 0) placedSpendPence += row.spendPence;
  }

  const rows: CampaignCostPerLead[] = [...buckets.values()]
    .map((bucket) => ({
      campaign: bucket.label,
      leads: bucket.leads,
      converted: bucket.converted,
      spendPence: bucket.spendPence,
      clicks: bucket.clicks,
      costPerLeadPence: bucket.spendPence !== null && bucket.leads > 0 ? Math.round(bucket.spendPence / bucket.leads) : null,
    }))
    .sort((a, b) => (b.spendPence ?? -1) - (a.spendPence ?? -1) || b.leads - a.leads || a.campaign!.localeCompare(b.campaign!));

  if (unattributedLeads > 0) {
    rows.push({ campaign: null, leads: unattributedLeads, converted: unattributedConverted, spendPence: null, costPerLeadPence: null, clicks: null });
  }

  const matchedLeads = rows.reduce((sum, row) => (row.campaign !== null && row.spendPence !== null ? sum + row.leads : sum), 0);
  return {
    from: v.from,
    to: v.to,
    rows,
    totalLeads,
    attributedLeads,
    matchedLeads,
    accountSpendPence: spend.accountSpendPence,
    placedSpendPence,
  };
}
