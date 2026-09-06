import { z } from "zod";

/**
 * The vault's kinds, spelled out here rather than imported from
 * `@launchos/core`: this module is shared with the client-side resolver, and
 * core would pull the Postgres driver into the browser bundle. `schemas.test.ts`
 * holds this list to core's `ACCESS_KINDS`.
 */
export const ACCESS_KIND_VALUES = [
  "dashboard",
  "server",
  "ssh",
  "database",
  "dns",
  "registrar",
  "hosting_panel",
  "email",
  "other",
] as const;

// Untouched inputs post "" — these become undefined before the rules run, the
// same shape as `clients/schemas.ts` and for the same react-hook-form reason.
const blank = z.string().optional().transform((v) => (v?.trim() ? v.trim() : undefined));
const optionalText = (max: number) => blank.pipe(z.string().max(max).optional());
const optionalUrl = blank.pipe(
  z.string().regex(/^https?:\/\//i, "Must be a full URL, with https://").url("Must be a full URL, with https://").optional(),
);
// The number input posts a string; the edit form is also handed the stored
// number. Both shapes are accepted on the input side so react-hook-form's
// resolver sees an output it can assign back (the `BillingSchema` pattern).
const optionalPort = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (typeof v === "number") return v;
    const trimmed = v.trim();
    if (!trimmed) return undefined;
    if (!/^\d{1,5}$/.test(trimmed)) {
      ctx.addIssue({ code: "custom", message: "Port must be a number" });
      return z.NEVER;
    }
    return Number(trimmed);
  })
  .pipe(z.number().int().min(1, "Port must be between 1 and 65535").max(65535, "Port must be between 1 and 65535").optional());
/** Not trimmed: a password is exactly what was typed. Blank means "none". */
const optionalSecret = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))
  .pipe(z.string().max(4000).optional());

const entryFields = {
  kind: z.enum(ACCESS_KIND_VALUES),
  label: z.string().trim().min(1, "Label is required").max(200),
  url: optionalUrl,
  host: optionalText(253),
  port: optionalPort,
  username: optionalText(200),
  secret: optionalSecret,
  siteId: blank.pipe(z.string().uuid("Choose a website or leave it blank").optional()),
  notes: optionalText(4000),
};

export const NewAccessEntrySchema = z.object({ clientId: z.string().uuid(), ...entryFields });
export type NewAccessEntryValues = z.input<typeof NewAccessEntrySchema>;

/**
 * Edit posts every field, so an emptied one clears the column — except the
 * password, which a blank field leaves alone (there is nothing to prefill it
 * with) and `clearSecret` removes.
 */
export const EditAccessEntrySchema = z.object({
  entryId: z.string().uuid(),
  clientId: z.string().uuid(),
  ...entryFields,
  /** Optional rather than defaulted so the resolver's output stays assignable to its input. */
  clearSecret: z.boolean().optional(),
});
export type EditAccessEntryValues = z.input<typeof EditAccessEntrySchema>;

export const AccessEntryRefSchema = z.object({ entryId: z.string().uuid(), clientId: z.string().uuid() });
export type AccessEntryRefValues = z.input<typeof AccessEntryRefSchema>;

export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };
export type RevealResult = { status: "ok"; secret: string } | { status: "error"; message: string };
