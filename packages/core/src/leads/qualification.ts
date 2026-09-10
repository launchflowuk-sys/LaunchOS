import { z } from "zod";

/**
 * What a lead told us about themselves before anybody spoke to them.
 *
 * The point of asking is not politeness. Everything downstream — the Brief
 * Writer, the content plan, the site build — starts from whatever came in, and
 * what came in was a name, an email and a sentence. So the first real work on
 * every job was a phone call to find out what the business actually does, and
 * nothing could begin without Shoji doing it.
 *
 * These are the answers that remove that call. Every field is optional except
 * the ones the contact form already required, because a half-finished wizard is
 * still a lead worth chasing — somebody who told us their industry and then
 * closed the tab is more use than nobody.
 *
 * Stored in its own column rather than `metadata`, which already carries what
 * the *source* knew: UTM tags, the page the form was on, a Checkout session id.
 * This is what the *person* said, it is read by agents, and the two should not
 * be rummaged out of one bag.
 */

export const TRADING_STRUCTURES = ["sole_trader", "limited_company", "partnership", "not_sure"] as const;
export type TradingStructure = (typeof TRADING_STRUCTURES)[number];

export const TRADING_STRUCTURE_LABEL: Record<TradingStructure, string> = {
  sole_trader: "Sole trader",
  limited_company: "Limited company",
  partnership: "Partnership",
  not_sure: "Not sure yet",
};

/** Answered as yes / no / don't know, because "no" and "I have no idea" are different jobs. */
export const TRIAGE_ANSWERS = ["yes", "no", "unsure"] as const;
export type TriageAnswer = (typeof TRIAGE_ANSWERS)[number];

export const TRIAGE_LABEL: Record<TriageAnswer, string> = {
  yes: "Yes",
  no: "No",
  unsure: "Not sure",
};

export const LeadQualification = z.object({
  /** What trade they are in, in their own words. The single most useful answer. */
  industry: z.string().trim().max(120).optional(),
  tradingStructure: z.enum(TRADING_STRUCTURES).optional(),
  /** An existing site, if they have one. Judged before the call rather than during it. */
  websiteUrl: z.string().trim().max(300).optional(),
  hasGoogleListing: z.enum(TRIAGE_ANSWERS).optional(),
  hasFacebookPage: z.enum(TRIAGE_ANSWERS).optional(),
  /** What they sell, as a list they typed. */
  services: z.string().trim().max(2000).optional(),
  /** Where they work — a town, a radius, "nationwide". */
  serviceArea: z.string().trim().max(200).optional(),
  /** What they are actually trying to achieve, which is rarely "a website". */
  goals: z.string().trim().max(2000).optional(),
  /** How soon. Free text on purpose: "before the summer" is an answer. */
  timeline: z.string().trim().max(200).optional(),
  /** What they think they need, when they already have a view. */
  budget: z.string().trim().max(200).optional(),
});
export type LeadQualification = z.infer<typeof LeadQualification>;

/** Nothing answered at all — worth knowing, so a bare lead is not described as qualified. */
export function isEmptyQualification(value: LeadQualification): boolean {
  return Object.values(value).every((entry) => entry === undefined || entry === "");
}

/**
 * How much of it they filled in, 0–1.
 *
 * Used to sort the pile: a lead who answered everything is a different
 * proposition from one who gave a name and left, and the difference should be
 * visible without opening either.
 */
export function qualificationCompleteness(value: LeadQualification): number {
  const fields = Object.keys(LeadQualification.shape) as (keyof LeadQualification)[];
  const answered = fields.filter((field) => {
    const entry = value[field];
    return entry !== undefined && entry !== "";
  }).length;
  return fields.length === 0 ? 0 : answered / fields.length;
}
