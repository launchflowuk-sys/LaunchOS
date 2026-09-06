import type { FunnelStep } from "@launchos/db/schema";
import { z } from "zod";

/**
 * A funnel's questions, as a validated shape.
 *
 * The rule that makes a funnel a funnel rather than a long form is enforced
 * here: **exactly one contact step, and it may not be the last one.** A funnel
 * that asks for the phone number at the end is a contact form with extra
 * screens, and the whole reason the Funnel Engine earned its keep was that a
 * visitor who gets bored at screen four has already told us who they are.
 */

const Key = z.string().trim().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*$/, "a step key is lower-case letters, numbers and hyphens");
const Question = z.string().trim().min(1).max(300);

export const FunnelChoiceOptionSchema = z.object({
  value: z.string().trim().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*$/, "an option value is lower-case letters, numbers and hyphens"),
  label: z.string().trim().min(1).max(120),
  /** Negative is allowed and useful: "just looking" should cost a funnel points, not merely fail to earn any. */
  points: z.number().int().min(-100).max(100).default(0),
});

export const FunnelStepSchema = z.object({
  key: Key,
  kind: z.enum(["choice", "text", "contact"]),
  question: Question,
  help: z.string().trim().max(300).optional(),
  required: z.boolean().default(true),
  options: z.array(FunnelChoiceOptionSchema).max(8).optional(),
  placeholder: z.string().trim().max(120).optional(),
  contact: z.object({
    askEmail: z.boolean().default(true),
    askBusiness: z.boolean().default(false),
    /**
     * Off by default. The acknowledgement email needs an address, but a phone
     * number on its own is still a lead worth having, and a required field is
     * the commonest reason a half-finished funnel produces nothing at all.
     */
    emailRequired: z.boolean().default(false),
  }).optional(),
}).superRefine((step, ctx) => {
  if (step.kind === "choice" && (step.options === undefined || step.options.length < 2)) {
    ctx.addIssue({ code: "custom", message: `step "${step.key}" is a choice and needs at least two options`, path: ["options"] });
  }
  if (step.kind !== "choice" && step.options !== undefined && step.options.length > 0) {
    ctx.addIssue({ code: "custom", message: `step "${step.key}" is not a choice, so it cannot carry options`, path: ["options"] });
  }
});

export const FunnelStepsSchema = z
  .array(FunnelStepSchema)
  .min(2, "a funnel needs at least two steps")
  .max(10, "a funnel longer than ten steps is a form, not a funnel")
  .superRefine((steps, ctx) => {
    const keys = new Set<string>();
    for (const step of steps) {
      if (keys.has(step.key)) ctx.addIssue({ code: "custom", message: `two steps share the key "${step.key}"` });
      keys.add(step.key);
    }
    const contactAt = steps.findIndex((step) => step.kind === "contact");
    if (contactAt === -1) {
      ctx.addIssue({ code: "custom", message: "a funnel needs a contact step — it is the only screen that produces a lead" });
      return;
    }
    if (steps.filter((step) => step.kind === "contact").length > 1) {
      ctx.addIssue({ code: "custom", message: "a funnel has one contact step, not several" });
    }
    if (contactAt === steps.length - 1) {
      ctx.addIssue({
        code: "custom",
        message: "the contact step goes in the middle, not last — a visitor who stops early should already have given us their number",
      });
    }
  });

export const FunnelSuccessSchema = z.object({
  headline: z.string().trim().min(1).max(160),
  body: z.string().trim().max(600).default(""),
  ctaLabel: z.string().trim().max(60).optional(),
  ctaUrl: z.string().trim().max(500).url().optional(),
});

/** Where the contact step sits, zero-based. `-1` for a funnel that somehow has none. */
export function contactStepIndex(steps: readonly FunnelStep[]): number {
  return steps.findIndex((step) => step.kind === "contact");
}

/** The best score a funnel can produce — what a score is read against. */
export function maximumScore(steps: readonly FunnelStep[]): number {
  return steps.reduce((total, step) => {
    const best = (step.options ?? []).reduce((high, option) => Math.max(high, option.points), 0);
    return total + best;
  }, 0);
}

/**
 * A sensible starting funnel, so "New funnel" produces something a visitor
 * could walk through rather than an empty page waiting to be configured. Six
 * screens, contact at three.
 */
export function defaultFunnelSteps(): FunnelStep[] {
  return [
    {
      key: "goal", kind: "choice", required: true,
      question: "What do you need most right now?",
      options: [
        { value: "new-website", label: "A new website", points: 25 },
        { value: "more-enquiries", label: "More enquiries from the site I have", points: 30 },
        { value: "ads", label: "Someone to run my ads", points: 30 },
        { value: "looking", label: "Just having a look", points: -10 },
      ],
    },
    {
      key: "timing", kind: "choice", required: true,
      question: "When would you want it live?",
      options: [
        { value: "asap", label: "As soon as possible", points: 30 },
        { value: "this-quarter", label: "Within three months", points: 20 },
        { value: "later", label: "Later this year", points: 5 },
        { value: "unsure", label: "Not sure yet", points: 0 },
      ],
    },
    {
      key: "contact", kind: "contact", required: true,
      question: "Who should we come back to?",
      help: "Your name and number is enough — we will do the rest.",
      contact: { askEmail: true, askBusiness: true, emailRequired: false },
    },
    {
      key: "budget", kind: "choice", required: false,
      question: "Roughly what have you set aside each month?",
      options: [
        { value: "under-250", label: "Under £250", points: 5 },
        { value: "250-500", label: "£250 – £500", points: 20 },
        { value: "over-500", label: "Over £500", points: 30 },
        { value: "unsure", label: "I would rather talk it through", points: 10 },
      ],
    },
    {
      key: "sector", kind: "text", required: false,
      question: "What does your business do?",
      placeholder: "Taxi firm, dentist, builder…",
    },
    {
      key: "detail", kind: "text", required: false,
      question: "Anything else we should know before we call?",
      placeholder: "Optional",
    },
  ];
}

export type FunnelStepsInput = z.input<typeof FunnelStepsSchema>;
