import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "../audit/record-audit.js";
import { createLead } from "./leads.js";
import { normalisePhone } from "./phone.js";

/**
 * A message that arrived on a number Shoji advertises.
 *
 * The channel is deliberately not an enum: SMS today, WhatsApp when the Cloud
 * API lands on a second number, and whatever comes after. It is recorded as the
 * lead's `source`, which is free text for the same reason.
 */
export const InboundEnquiryInput = z.object({
  channel: z.string().trim().min(1).max(40),
  /** The sender, in whatever shape the provider gave it. Normalised here. */
  from: z.string().trim().min(1).max(40),
  body: z.string().trim().max(4000),
  /** The provider's own id, so the same delivery twice is one lead. */
  externalId: z.string().trim().max(200).optional(),
  receivedAt: z.date().optional(),
});
export type InboundEnquiryInput = z.input<typeof InboundEnquiryInput>;

export type InboundEnquiryOutcome =
  /** On the suppression list. Nothing was written and nothing will reply. */
  | { action: "suppressed"; phone: string }
  /** Read, and not new business. No lead, so no sales reply is ever drafted. */
  | { action: "ignored"; phone: string; reason: string }
  /** A lead now exists; `lead.created` carries it on to the Lead Qualifier. */
  | { action: "lead_created"; phone: string; leadId: string }
  /** This number already has an open lead. Left alone rather than duplicated. */
  | { action: "already_open"; phone: string; leadId: string };

/**
 * Words that mean somebody is asking about the work, not saying hello.
 *
 * A deliberately dull list rather than a model, because the cost of the two
 * mistakes is not symmetric. A missed enquiry sits in the message list and
 * Shoji reads it anyway; a false positive puts a stranger's private text on the
 * leads board and points an agent at drafting them a sales pitch. So this
 * errs toward silence, and the ones it misses are still visible.
 */
const ENQUIRY_TERMS = [
  "website", "web site", "web design", "webdesign", "site", "landing page",
  "seo", "google", "ranking", "rank", "search",
  "quote", "quotation", "price", "pricing", "cost", "how much", "charge",
  "app", "application", "booking", "online", "domain", "hosting",
  "logo", "branding", "brand", "redesign", "rebuild",
  "social media", "facebook", "instagram", "ads", "advertising", "marketing",
  "enquiry", "enquire", "inquiry", "interested", "looking for", "need a",
  "business", "shop", "e-commerce", "ecommerce", "online store",
];

/** Two words in a row is a wrong number, not a brief. */
const MIN_ENQUIRY_WORDS = 3;

export interface EnquiryVerdict {
  isEnquiry: boolean;
  reason: string;
  /** The terms that matched, for the audit row and for tuning the list later. */
  matched: string[];
}

/**
 * Does this read like somebody asking about the work?
 *
 * Exported because the decision is worth testing on its own and worth showing
 * on screen — an operator who cannot see why a message was ignored has no way
 * to tell a bad rule from a quiet week.
 */
export function classifyEnquiry(body: string): EnquiryVerdict {
  const text = body.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);

  if (words.length < MIN_ENQUIRY_WORDS) {
    return { isEnquiry: false, reason: "too short to be an enquiry", matched: [] };
  }

  const matched = ENQUIRY_TERMS.filter((term) => text.includes(term));
  if (matched.length === 0) {
    return { isEnquiry: false, reason: "nothing in it is about the work", matched: [] };
  }

  return { isEnquiry: true, reason: `mentions ${matched.slice(0, 3).join(", ")}`, matched };
}

/** True when this number must never become a lead. */
export async function isSuppressed(db: Db, organisationId: string, phone: string): Promise<boolean> {
  const [row] = await db.select({ id: schema.leadSuppressions.id })
    .from(schema.leadSuppressions)
    .where(and(
      eq(schema.leadSuppressions.organisationId, organisationId),
      eq(schema.leadSuppressions.phone, phone),
    ));
  return Boolean(row);
}

/**
 * Turns a message into a lead, or decides not to.
 *
 * The order is the whole design, and it is deliberate:
 *
 * 1. **Suppression first, before anything is read or written.** A number on the
 *    list produces no lead, no audit of its contents and no reply. That is the
 *    point of the list — Shoji's family and his existing clients text this
 *    number too.
 * 2. **Then whether it is new business at all.** Anything that is not gets no
 *    lead, so the Lead Qualifier is never pointed at a stranger's private text.
 * 3. **Then whether this number is already talking to us.** A person sending
 *    three messages in a row is one lead, not three, and a second message while
 *    a lead is open belongs on that lead rather than on a new one.
 *
 * Nothing here sends anything. A lead is created and `lead.created` carries it
 * to the Lead Qualifier, which drafts a reply for Shoji to approve — the same
 * gate as every other outward message.
 */
export async function ingestInboundEnquiry(
  db: Db,
  organisationId: string,
  input: InboundEnquiryInput,
): Promise<InboundEnquiryOutcome> {
  const v = InboundEnquiryInput.parse(input);
  const phone = normalisePhone(v.from);

  if (await isSuppressed(db, organisationId, phone)) {
    return { action: "suppressed", phone };
  }

  const verdict = classifyEnquiry(v.body);
  if (!verdict.isEnquiry) {
    await recordAudit(db, organisationId, {
      actorKind: "system",
      action: "lead.inbound_ignored",
      // Nothing was created, so the number is what the decision was about.
      targetType: "inbound_message",
      targetId: phone,
      // The message itself is not kept: it was decided not to be our business.
      after: { channel: v.channel, phone, reason: verdict.reason },
    });
    return { action: "ignored", phone, reason: verdict.reason };
  }

  const [open] = await db.select({ id: schema.leads.id, status: schema.leads.status })
    .from(schema.leads)
    .where(and(
      eq(schema.leads.organisationId, organisationId),
      eq(schema.leads.phone, phone),
    ));
  if (open && open.status !== "lost" && open.status !== "converted") {
    return { action: "already_open", phone, leadId: open.id };
  }

  const lead = await createLead(db, organisationId, {
    // The channel gave a number, not a name. Shoji names them when he replies.
    name: phone,
    phone,
    message: v.body,
    source: v.channel,
    metadata: {
      inbound: true,
      matched: verdict.matched,
      ...(v.externalId ? { externalId: v.externalId } : {}),
      receivedAt: (v.receivedAt ?? new Date()).toISOString(),
    },
    actorKind: "system",
  });

  return { action: "lead_created", phone, leadId: lead.id };
}
