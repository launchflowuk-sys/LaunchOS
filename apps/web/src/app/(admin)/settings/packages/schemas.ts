import { z } from "zod";

export type ActionResult = { status: "ok"; id?: string } | { status: "error"; message: string };

/** What a retainer buys each month. Quantities drive recurring generation. */
export const IncludesSchema = z.object({
  website: z.boolean(),
  seo: z.boolean(),
  ads: z.boolean(),
  socialPostsPerMonth: z.coerce.number().int().min(0).max(60),
  blogPostsPerMonth: z.coerce.number().int().min(0).max(60),
  gbpUpdatesPerMonth: z.coerce.number().int().min(0).max(60),
});

const BaseFields = {
  name: z.string().trim().min(1, "Name is required").max(120),
  // An emptied textarea becomes undefined so an update can clear the column.
  description: z.string().trim().max(2000).transform((v) => (v.length > 0 ? v : undefined)),
  monthlyPricePence: z.coerce.number().int().min(0).max(100_000_000),
  setupPricePence: z.coerce.number().int().min(0).max(100_000_000),
  includes: IncludesSchema,
};

export const CreatePackageSchema = z.object({
  ...BaseFields,
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .max(80)
    .regex(/^[a-z0-9-]+$/, "Slug is lowercase letters, digits and hyphens"),
});

// The slug is the stable key other rows point at, so it is not editable.
export const UpdatePackageSchema = z.object({
  ...BaseFields,
  packageId: z.string().uuid(),
  active: z.boolean(),
  // The Stripe Price the self-serve sign-up sells this package under. Blank
  // clears it and puts the package back on the "we'll invoice you" flow.
  stripePriceId: z
    .string()
    .trim()
    .max(200)
    .regex(/^(price_[A-Za-z0-9]+)?$/, "A Stripe price id starts with price_")
    .transform((v) => (v.length > 0 ? v : null)),
});

/** An unticked checkbox posts nothing; an empty number input posts "". */
export function readIncludes(formData: FormData) {
  return {
    website: formData.get("website") === "on",
    seo: formData.get("seo") === "on",
    ads: formData.get("ads") === "on",
    socialPostsPerMonth: formData.get("socialPostsPerMonth") || 0,
    blogPostsPerMonth: formData.get("blogPostsPerMonth") || 0,
    gbpUpdatesPerMonth: formData.get("gbpUpdatesPerMonth") || 0,
  };
}

export function readPackageBase(formData: FormData) {
  return {
    name: formData.get("name"),
    description: formData.get("description") ?? "",
    monthlyPricePence: formData.get("monthlyPricePence") || 0,
    setupPricePence: formData.get("setupPricePence") || 0,
  };
}
