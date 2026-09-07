/**
 * The facts every marketing page shares. Copy that is Shoji's to change
 * lives here rather than inside a component, so a new phone number is a
 * one-line edit.
 */

export const SITE_NAME = "LaunchFlow";
export const SITE_TAGLINE = "We build the software we run our own businesses on.";
export const SITE_DESCRIPTION =
  "LaunchFlow, Grays, Essex. Web applications, mobile apps, websites and hosting, design, ad management and AI agents for local businesses — built and hosted in-house.";

export const CONTACT_EMAIL = "hello@launchflow.co.uk";
/** Leave blank until Shoji chooses the number he wants published; the pages hide it while empty. */
export const CONTACT_PHONE: string = "";
export const LOCATION = "Grays, Essex";
export const REPLY_PROMISE = "Shoji will reply within one working day.";

export const NAV = [
  { label: "Work", path: "/work" },
  { label: "Services", path: "/services" },
  { label: "Products", path: "/products" },
  { label: "About", path: "/about" },
  { label: "Pricing", path: "/pricing" },
] as const;

/** The line under the wordmark in the footer, and the studio's one-sentence promise. */
export const FOOTER_LINE = "Thoughtful design. Useful software. A partner for the long run.";
export const STUDIO_EYEBROW = "Independent digital studio · Essex, UK";

/** Every indexable marketing path, for the sitemap; work briefs are added from the published case studies. */
export const STATIC_PATHS = ["/", "/work", "/products", "/services", "/pricing", "/about", "/contact", "/privacy"] as const;

/** The image every page shares for link previews. 600×144, the wordmark. */
/**
 * The image every link preview shows. 1200×630, which is what Facebook,
 * WhatsApp, LinkedIn and X all ask for and roughly what each of them crops to.
 *
 * It used to be the wordmark at 600×144. That is a logo, not a share card:
 * too small for several platforms to accept at all, and the wrong shape for
 * the ones that do — a link to the site arrived in a WhatsApp thread as plain
 * text or a sliver of a strip.
 */
export const OG_IMAGE = {
  url: "/brand/og-launchflow.png",
  width: 1200,
  height: 630,
  alt: "LaunchFlow — built to work, designed to stand out",
} as const;

/**
 * One page's metadata, with the share card attached.
 *
 * This exists because of a bug that hid the image on every page for months.
 * Next.js **replaces** a parent `openGraph` rather than merging into it, so a
 * page that set `openGraph: { title, description, url }` silently dropped the
 * layout's `images` — every page did, and so the site had `og:title` and
 * `og:description` and no picture anywhere.
 *
 * Building the object here rather than by hand at eight call sites means the
 * image cannot be forgotten again, and `summary_large_image` is set once. The
 * `image` argument is for a page with a better one of its own — a case study
 * uses its own screenshot.
 */
export function marketingMetadata(input: {
  title: string;
  description: string;
  path: string;
  /** Overrides the share card. Absolute path from the site root. */
  image?: { url: string; width?: number; height?: number; alt?: string };
  /** Titles the home page absolutely, rather than through the "— LaunchFlow" template. */
  absoluteTitle?: boolean;
}) {
  const image = input.image ?? OG_IMAGE;
  const shareTitle = input.absoluteTitle ? input.title : `${input.title} — ${SITE_NAME}`;
  return {
    title: input.absoluteTitle ? { absolute: input.title } : input.title,
    description: input.description,
    alternates: { canonical: input.path },
    openGraph: {
      title: shareTitle,
      description: input.description,
      url: input.path,
      type: "website" as const,
      siteName: SITE_NAME,
      locale: "en_GB",
      images: [image],
    },
    twitter: {
      // The big card, not the 120px thumbnail `summary` gives you.
      card: "summary_large_image" as const,
      title: shareTitle,
      description: input.description,
      images: [image.url],
    },
  };
}
