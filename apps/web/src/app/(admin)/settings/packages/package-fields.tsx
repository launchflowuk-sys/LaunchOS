import type { PackageIncludes } from "@launchos/db/schema";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
 *
 * `idPrefix` is what keeps `htmlFor` honest. This block is rendered once per
 * package on the same screen, and a server component has no `useId`, so the
 * caller passes the package id (or "new") and every control on the page still
 * gets a unique id its own label points at.
 */
export function PackageFields({
  defaults,
  idPrefix,
}: {
  defaults: {
    name: string;
    description: string;
    monthlyPricePence: number;
    setupPricePence: number;
    includes: PackageIncludes;
  };
  idPrefix: string;
}) {
  const id = (field: string) => `${idPrefix}-${field}`;

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={id("name")}>Name</Label>
          <Input id={id("name")} name="name" required maxLength={120} defaultValue={defaults.name} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id("description")}>Description</Label>
          <Input id={id("description")} name="description" maxLength={2000} defaultValue={defaults.description} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={id("monthlyPricePence")}>Monthly price (pence)</Label>
          <Input
            id={id("monthlyPricePence")}
            type="number"
            name="monthlyPricePence"
            min={0}
            defaultValue={defaults.monthlyPricePence}
            className="tabular-nums"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id("setupPricePence")}>Setup price (pence)</Label>
          <Input
            id={id("setupPricePence")}
            type="number"
            name="setupPricePence"
            min={0}
            defaultValue={defaults.setupPricePence}
            className="tabular-nums"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {QUANTITIES.map((quantity) => (
          <div key={quantity.name} className="space-y-1.5">
            <Label htmlFor={id(quantity.name)}>{quantity.label}</Label>
            <Input
              id={id(quantity.name)}
              type="number"
              name={quantity.name}
              min={0}
              max={60}
              defaultValue={defaults.includes[quantity.name]}
              className="tabular-nums"
            />
          </div>
        ))}
      </div>

      <fieldset className="flex flex-wrap gap-x-6 gap-y-3">
        <legend className="label-caps mb-2 text-muted-foreground">Includes</legend>
        {FLAGS.map((flag) => (
          <label key={flag.name} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name={flag.name}
              defaultChecked={defaults.includes[flag.name]}
              className="size-4 rounded-[4px] border-input accent-primary"
            />
            {flag.label}
          </label>
        ))}
      </fieldset>
    </>
  );
}
