import { type LeadAttribution, LeadAttributionSchema } from "@launchos/core";
import { cookies } from "next/headers";
import { ATTRIBUTION_COOKIE, decodeAttribution } from "./attribution";

/**
 * The campaign the visitor arrived with, read from the `lf_attr` cookie in a
 * server action and validated with core's own schema — the same rule that
 * runs on `createLead`, so a cookie somebody edited by hand is a 400 here
 * rather than a thrown Zod error there. Undefined when there is nothing to
 * pass, so `createLead` stores no attribution at all rather than `{}`.
 *
 * Server-only: `next/headers` is what keeps it out of the browser bundle.
 */
export async function readAttributionCookie(): Promise<LeadAttribution | undefined> {
  const raw = (await cookies()).get(ATTRIBUTION_COOKIE)?.value ?? null;
  const decoded = decodeAttribution(raw);
  if (Object.keys(decoded).length === 0) return undefined;
  const parsed = LeadAttributionSchema.safeParse(decoded);
  return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
}
