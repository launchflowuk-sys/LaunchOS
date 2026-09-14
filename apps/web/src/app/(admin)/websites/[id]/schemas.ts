import { z } from "zod";

/** Local to this module, matching the shape the other admin modules use. */
export type ActionResult = { status: "ok"; message?: string } | { status: "error"; message: string };

export const WordPressConnectionSchema = z.object({
  siteId: z.string().uuid(),
  username: z.string().trim().min(1, "Username is required").max(200),
  /**
   * WordPress prints application passwords as six four-character groups. The
   * spaces are kept — WordPress accepts the value with or without them, and
   * stripping them would make a pasted value look wrong when it is read back.
   */
  appPassword: z.string().trim().min(1, "Application password is required").max(500),
});
export type WordPressConnectionValues = z.input<typeof WordPressConnectionSchema>;

export const TestWordPressConnectionSchema = z.object({ siteId: z.string().uuid() });
export type TestWordPressConnectionValues = z.input<typeof TestWordPressConnectionSchema>;

/**
 * The reviews settings on one site.
 *
 * Bounds mirror `SiteSlug` and `SiteReviewSettingsInput` in
 * `packages/core/src/sites/reviews.ts`, so a bad slug is a sentence on the
 * form rather than a Zod error thrown out of core. Nothing here may import
 * `@launchos/core` — see the note at the top of this file.
 */
export const SiteReviewsSchema = z.object({
  siteId: z.string().uuid(),
  slug: z
    .union([
      z.literal(""),
      z
        .string()
        .trim()
        .toLowerCase()
        .min(2)
        .max(120)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a slug is lowercase letters, numbers and single hyphens"),
    ])
    .optional(),
  googlePlaceId: z.union([z.literal(""), z.string().trim().min(5, "a place id is longer than that").max(400)]).optional(),
  reviewsEnabled: z.boolean(),
});

export const RefreshSiteReviewsSchema = z.object({ siteId: z.string().uuid() });
