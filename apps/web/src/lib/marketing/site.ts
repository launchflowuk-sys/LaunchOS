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
  { label: "Products", path: "/products" },
  { label: "Services", path: "/services" },
  { label: "Pricing", path: "/pricing" },
  { label: "About", path: "/about" },
] as const;

/** Every indexable marketing path, for the sitemap; work briefs are added from the data file. */
export const STATIC_PATHS = ["/", "/work", "/products", "/services", "/pricing", "/about", "/contact", "/privacy"] as const;

/** The image every page shares for link previews. 600×144, the wordmark. */
export const OG_IMAGE = { url: "/brand/launchflow-logo@600.png", width: 600, height: 144, alt: "LaunchFlow" } as const;
