import { z } from "zod";

/**
 * The review form, read back: `product` once per ticked product,
 * `fileUnder:<customerId>` once per customer the owner could place, and
 * `clientName:<customerId>` beside it for the "Create new client" choice.
 *
 * Kept apart from `actions.ts` so the reading is a pure function with a test,
 * and because a "use server" module may export only async functions.
 */
export interface ImportForm {
  selectedProductIds: string[];
  clientNames: Record<string, string>;
  fileUnder: Record<string, string>;
}

/** What the "File under" select posts: a new client, or one of ours. */
export const NEW_CLIENT = "new";
/** Nothing chosen: the "leave it" answer for a cancelled subscription nobody knows. */
export const LEAVE = "";

/**
 * Where the select starts: the preview's email match, else "leave it" for a
 * cancelled subscription (the import never invents a client for a
 * relationship that has ended), else a new client.
 */
export function initialFileUnderChoice(row: { matchedClientId: string | null; status: string }): string {
  if (row.matchedClientId) return row.matchedClientId;
  return row.status === "cancelled" ? LEAVE : NEW_CLIENT;
}

const CLIENT_NAME_FIELD = /^clientName:(.+)$/;
const FILE_UNDER_FIELD = /^fileUnder:(.+)$/;
const ProductIds = z.array(z.string().trim().min(1).max(200));
const ClientName = z.string().trim().max(200);
const FileUnder = z.union([z.literal(NEW_CLIENT), z.string().uuid()]);

function stringEntries(formData: FormData, pattern: RegExp): [string, string][] {
  const out: [string, string][] = [];
  for (const [field, value] of formData.entries()) {
    const match = pattern.exec(field);
    if (match && typeof value === "string") out.push([match[1]!, value]);
  }
  return out;
}

/**
 * Throws a `ZodError` on a product list that is not a list of ids. A blank
 * "File under" (the "leave it" choice on a cancelled subscription) and a
 * blank name are dropped rather than refused: core then does what the
 * preview showed. A value that is neither `new` nor a uuid is dropped too —
 * the select never posts one, so it is a direct POST guessing at ids.
 */
export function readImportForm(formData: FormData): ImportForm {
  const selectedProductIds = ProductIds.parse(formData.getAll("product").filter((v): v is string => typeof v === "string"));

  const clientNames: Record<string, string> = {};
  for (const [customerId, value] of stringEntries(formData, CLIENT_NAME_FIELD)) {
    const parsed = ClientName.safeParse(value);
    if (parsed.success && parsed.data.length > 0) clientNames[customerId] = parsed.data;
  }

  const fileUnder: Record<string, string> = {};
  for (const [customerId, value] of stringEntries(formData, FILE_UNDER_FIELD)) {
    const parsed = FileUnder.safeParse(value.trim());
    if (parsed.success) fileUnder[customerId] = parsed.data;
  }

  return { selectedProductIds, clientNames, fileUnder };
}
