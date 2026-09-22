/**
 * The five category hues from DESIGN.md, plus `overview` for the dashboard.
 *
 * They mark a *place* in the product — a nav group, a page-header accent dot, a
 * stat card's number. They never fill a button, never colour body text, and
 * never carry state: "needs you" is the semantic vocabulary's job
 * (`success | warning | danger | info`), not this one.
 *
 * The class strings are written out in full rather than composed, because
 * Tailwind only ships a class it can see as a literal.
 */
/**
 * `accent` is the portal's, and the only one that is not a module: it paints a
 * card in whatever colour the **client** has chosen for their own portal.
 * The others name a part of the admin, which is a distinction that helps
 * somebody who knows the modules and confuses somebody who does not.
 */
export type Category =
  | "overview" | "delivery" | "support" | "money" | "automation" | "organisation" | "accent";

/** Foreground: stat card numbers, small icons. */
export const CATEGORY_TEXT: Record<Category, string> = {
  accent: "text-primary",
  overview: "text-primary",
  delivery: "text-category-delivery",
  support: "text-category-support",
  money: "text-category-money",
  automation: "text-category-automation",
  organisation: "text-category-organisation",
};

/** Fill: the 6px marker beside a nav group label, the page-header accent dot. */
export const CATEGORY_DOT: Record<Category, string> = {
  accent: "bg-primary",
  overview: "bg-primary",
  delivery: "bg-category-delivery",
  support: "bg-category-support",
  money: "bg-category-money",
  automation: "bg-category-automation",
  organisation: "bg-category-organisation",
};
