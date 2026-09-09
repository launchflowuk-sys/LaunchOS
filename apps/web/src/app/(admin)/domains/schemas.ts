import { z } from "zod";

/**
 * Local to this module rather than imported from `../clients/schemas` — Task 10
 * owns that file and defines its own `ActionResult` with the identical shape.
 */
export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

export const NewDnsRecordSchema = z.object({
  domainId: z.string().uuid(),
  type: z.enum(["A", "AAAA", "CNAME", "MX", "TXT", "SRV"]).default("A"),
  name: z.string().trim().min(1, "Name is required").max(253),
  value: z.string().trim().min(1, "Value is required").max(1000),
  ttl: z.coerce.number().int().min(60).max(86400).default(3600),
});
export type NewDnsRecordValues = z.input<typeof NewDnsRecordSchema>;

export const AttachSiteSchema = z.object({
  domainId: z.string().uuid(),
  siteId: z.union([z.literal(""), z.string().uuid()]),
});
export type AttachSiteValues = z.input<typeof AttachSiteSchema>;

export const DeleteDnsRecordSchema = z.object({
  recordId: z.string().uuid(),
  domainId: z.string().uuid(),
});
export type DeleteDnsRecordValues = z.input<typeof DeleteDnsRecordSchema>;

export const MoveDomainSchema = z.object({
  domainId: z.string().uuid(),
  clientId: z.string().uuid("Choose the client the domain belongs to"),
});
export type MoveDomainValues = z.input<typeof MoveDomainSchema>;

/**
 * Deleting a domain is the only way to free its name: the unique index is on
 * (organisation, name) and archiving a client does not release it. Typing the
 * name is the confirmation, because this cascades the DNS records with it.
 */
export const DeleteDomainSchema = z.object({
  domainId: z.string().uuid(),
  confirmName: z.string().trim().min(1, "Type the domain name to confirm"),
});
export type DeleteDomainValues = z.input<typeof DeleteDomainSchema>;

/**
 * An emptied date input posts "", which means "no renewal date on record" and
 * therefore "stop reminding me" — not "leave whatever was there". So it
 * becomes null rather than undefined.
 */
export const SaveRenewalSchema = z.object({
  domainId: z.string().uuid(),
  expiresAt: z
    .string()
    .trim()
    .transform((v) => (v.length > 0 ? v : null))
    .refine((v) => v === null || !Number.isNaN(Date.parse(v)), "That is not a date")
    .transform((v) => (v === null ? null : new Date(`${v}T00:00:00.000Z`))),
  registrar: z.string().trim().max(100).transform((v) => (v.length > 0 ? v : null)),
  autoRenew: z.boolean(),
});
