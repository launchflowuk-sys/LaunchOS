import { listPackages } from "@launchos/core";
import { schema } from "@launchos/db";
import { Package } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { createPackageAction, updatePackageAction } from "./actions";
import { PackageFields } from "./package-fields";

export const dynamic = "force-dynamic";

const CARD = "space-y-4 rounded-xl border bg-card p-4 sm:p-5";

export default async function PackagesPage() {
  const session = await requireAdmin();
  const packages = await listPackages(getDb(), session.organisationId, {});

  return (
    <>
      <PageHeader
        title="Packages"
        description="What each retainer includes. Quantities drive recurring task generation."
        category="organisation"
      />

      <Section title="New package">
        <ActionForm
          action={createPackageAction}
          ariaLabel="New package"
          success="Package created"
          resetOnSuccess
          className={CARD}
        >
          <PackageFields
            idPrefix="new-package"
            defaults={{
              name: "",
              description: "",
              monthlyPricePence: 0,
              setupPricePence: 0,
              includes: schema.PACKAGE_INCLUDES_DEFAULT,
            }}
          />
          <div className="space-y-1.5 sm:max-w-xs">
            <Label htmlFor="new-package-slug">Slug</Label>
            <Input
              id="new-package-slug"
              name="slug"
              required
              maxLength={80}
              pattern="[a-z0-9-]+"
              placeholder="website-care"
            />
          </div>
          <div className="flex justify-end max-sm:[&>*]:w-full">
            <Button type="submit">Create package</Button>
          </div>
        </ActionForm>
      </Section>

      <Section title="Existing packages">
        {packages.length === 0 ? (
          <EmptyState icon={Package}>
            No packages yet. The first one above becomes a client&rsquo;s retainer.
          </EmptyState>
        ) : (
          <div className="space-y-4">
            {packages.map((pkg) => (
              <ActionForm
                key={pkg.id}
                action={updatePackageAction}
                ariaLabel={`Package ${pkg.name}`}
                success="Package saved"
                className={CARD}
              >
                <input type="hidden" name="packageId" value={pkg.id} />
                <p className="text-base font-semibold">
                  {pkg.name} <span className="font-mono text-meta font-normal text-muted-foreground">/{pkg.slug}</span>
                </p>
                <PackageFields
                  idPrefix={`package-${pkg.id}`}
                  defaults={{
                    name: pkg.name,
                    description: pkg.description ?? "",
                    monthlyPricePence: pkg.monthlyPricePence,
                    setupPricePence: pkg.setupPricePence,
                    includes: pkg.includes,
                  }}
                />
                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="active"
                      defaultChecked={pkg.active}
                      className="size-4 rounded-[4px] border-input accent-primary"
                    />
                    Active
                  </label>
                  <Button type="submit" variant="secondary">
                    Save
                  </Button>
                </div>
              </ActionForm>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
