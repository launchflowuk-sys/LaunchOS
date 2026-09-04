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
