import type { PackageIncludes } from "@launchos/db/schema";

export const FIELD = "mt-1 h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900";
export const LABEL = "block text-xs font-medium text-neutral-500";

/** Quantities that drive recurring task generation, one task per unit a month. */
const QUANTITIES = [
  { name: "socialPostsPerMonth", label: "Social posts / month" },
  { name: "blogPostsPerMonth", label: "Blog posts / month" },
  { name: "gbpUpdatesPerMonth", label: "GBP updates / month" },
] as const;

/** Booleans that gate whole template families. */
const FLAGS = [
  { name: "website", label: "Website" },
  { name: "seo", label: "SEO" },
  { name: "ads", label: "Ads" },
] as const;

/**
 * The inputs shared by "New package" and every per-package edit form. A plain
 * server component: the surrounding `<form>` supplies the action.
 */
export function PackageFields({
  defaults,
}: {
  defaults: {
    name: string;
    description: string;
    monthlyPricePence: number;
    setupPricePence: number;
    includes: PackageIncludes;
  };
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Name
          <input name="name" required maxLength={120} defaultValue={defaults.name} className={FIELD} />
        </label>
        <label className={LABEL}>
          Description
          <input name="description" maxLength={2000} defaultValue={defaults.description} className={FIELD} />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className={LABEL}>
          Monthly price (pence)
          <input
            type="number"
            name="monthlyPricePence"
            min={0}
            defaultValue={defaults.monthlyPricePence}
            className={FIELD}
          />
        </label>
        <label className={LABEL}>
          Setup price (pence)
          <input
            type="number"
            name="setupPricePence"
            min={0}
            defaultValue={defaults.setupPricePence}
            className={FIELD}
          />
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        {QUANTITIES.map((quantity) => (
          <label key={quantity.name} className={LABEL}>
            {quantity.label}
            <input
              type="number"
              name={quantity.name}
              min={0}
              max={60}
              defaultValue={defaults.includes[quantity.name]}
              className={FIELD}
            />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap gap-4">
        {FLAGS.map((flag) => (
          <label key={flag.name} className="flex items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              name={flag.name}
              defaultChecked={defaults.includes[flag.name]}
              className="h-4 w-4 rounded border-neutral-300"
            />
            {flag.label}
          </label>
        ))}
      </div>
    </>
  );
}
