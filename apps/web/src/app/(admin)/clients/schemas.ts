import { z } from "zod";

// Shared by the client-side resolver and the server action, so one definition
// validates on both sides. Empty strings from untouched inputs become undefined
// before the email/url rules run, rather than failing them.
//
// Written as `.optional().transform().pipe()` rather than `z.preprocess`
// because preprocess types its *input* as `unknown`: react-hook-form then
// treats every such field as a possible object and widens `errors.<field>` to
// a nested `FieldErrors`, which the shared `TextField` error prop rejects
// under `exactOptionalPropertyTypes`. This form keeps the input `string`.
const blankToUndefined = z.string().optional().transform((v) => (v?.trim() ? v : undefined));
const optionalText = (max: number) => blankToUndefined.pipe(z.string().trim().max(max).optional());
const optionalEmail = blankToUndefined.pipe(z.string().email().optional());
const optionalUrl = blankToUndefined.pipe(z.string().url().optional());

export const NewClientSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  email: optionalEmail,
  phone: optionalText(40),
  addressLine1: optionalText(200),
  addressLine2: optionalText(200),
  city: optionalText(100),
  postcode: optionalText(20),
  websiteUrl: optionalUrl,
  industry: optionalText(100),
});
export type NewClientValues = z.input<typeof NewClientSchema>;

export const NewContactSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(200),
  email: optionalEmail,
  phone: optionalText(40),
  role: optionalText(100),
  isPrimary: z.boolean().default(false),
});
export type NewContactValues = z.input<typeof NewContactSchema>;

export const BillingSchema = z.object({
  clientId: z.string().uuid(),
  billingName: optionalText(200),
  addressLine1: optionalText(200),
  city: optionalText(100),
  postcode: optionalText(20),
  vatNumber: optionalText(40),
  // The number input posts a string; the server may also be handed the number
  // straight from the stored profile. `z.coerce` would type the input
  // `unknown`, so the accepted shapes are spelled out instead.
  paymentTermsDays: z
    .union([z.string(), z.number()])
    .transform((v) => (typeof v === "number" ? v : Number(v)))
    .pipe(z.number().int().min(0).max(180)),
  preferredMethod: optionalText(100),
});
export type BillingValues = z.input<typeof BillingSchema>;

export const NewSiteSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().trim().min(1, "Name is required").max(200),
  primaryUrl: z.string().url("Must be a full URL"),
  platform: z.enum(["wordpress", "static", "nextjs", "other"]).default("wordpress"),
});
export type NewSiteValues = z.input<typeof NewSiteSchema>;

export const NewDomainSchema = z.object({
  clientId: z.string().uuid(),
  name: z
    .string()
    .trim()
    .toLowerCase()
    .max(253)
    .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/, "Hostname only, no scheme or path"),
  registrar: optionalText(100),
  dnsProvider: z.enum(["cloudflare", "registrar", "other"]).default("other"),
});
export type NewDomainValues = z.input<typeof NewDomainSchema>;

export type ActionResult = { status: "ok"; id: string } | { status: "error"; message: string };
