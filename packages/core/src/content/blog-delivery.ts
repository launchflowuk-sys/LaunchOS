import type { SitePlatform } from "@launchos/db/schema";

/**
 * How an approved blog post reaches a client's website.
 *
 * There are two answers because there are two kinds of site, and pretending
 * otherwise is what left the majority unable to have a blog at all.
 *
 * **`push` — WordPress.** The site owns its own content. LaunchOS writes the
 * post in over the REST API and the post lives there afterwards, which is
 * right for a CMS somebody else may also edit. It costs a per-site
 * application password, and that is the price of the site being the owner.
 *
 * **`pull` — everything else.** The Next.js applications on Coolify, the
 * static sites, anything custom. LaunchOS keeps the post and serves it; the
 * application fetches what it needs and renders it. Nothing is pushed, so
 * there is no endpoint to add to each application, no shared secret to
 * distribute, and no credential for anyone to manage — the same reasoning as
 * the public reviews endpoint, which exists so a client's site can show its
 * reviews without holding a Google key.
 *
 * Scheduling is unaffected by the choice. A pulled post becomes visible when
 * the publish sweep marks it `published` at its scheduled time, because the
 * public endpoint only ever serves published items. "On schedule" is the same
 * promise either way.
 */
export type BlogDelivery = "push" | "pull";

/** Which delivery a site's platform gets. Derived, so there is no switch to forget. */
export function blogDeliveryFor(platform: SitePlatform): BlogDelivery {
  return platform === "wordpress" ? "push" : "pull";
}

/** How much of a title a slug keeps, before the id suffix. Enough to read, short enough to be a URL. */
const SLUG_TITLE_MAX = 70;

/** Characters of the item's uuid used to make a slug unique. */
const SLUG_ID_CHARS = 8;

/**
 * The permanent address of a pulled blog post: the title, then a short piece
 * of the item's id.
 *
 * The suffix is not decoration. Two posts can legitimately share a title, and
 * a collision would make one of them unreachable — so uniqueness comes from
 * the id rather than from hoping titles differ. Being derived from the id also
 * makes it deterministic and stable: the slug is computed once at publish time
 * and stored, so editing a title later cannot break a link somebody has
 * already shared.
 */
export function blogPostSlug(title: string | null, itemId: string): string {
  const suffix = itemId.replace(/-/g, "").slice(0, SLUG_ID_CHARS);
  const stem = (title ?? "")
    .normalize("NFD")
    // Strip combining marks so "Café" slugs as "cafe" rather than losing the e.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_TITLE_MAX)
    // The slice can land mid-separator; a trailing hyphen before the suffix
    // would read as a double.
    .replace(/-+$/, "");
  return stem ? `${stem}-${suffix}` : `post-${suffix}`;
}
