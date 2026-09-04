import { listPackages } from "@launchos/core";
import { schema } from "@launchos/db";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { createPackageAction, updatePackageAction } from "./actions";
import { FIELD, LABEL, PackageFields } from "./package-fields";

export const dynamic = "force-dynamic";

const CARD = "space-y-3 rounded-lg border border-neutral-200 bg-white p-4";

export default async function PackagesPage() {
  const session = await requireAdmin();
  const packages = await listPackages(getDb(), session.organisationId, {});

  return (
    <>
      <PageHeader
        title="Packages"
        description="What each retainer includes. Quantities drive recurring task generation."
      />

      <div className="space-y-6">
        <section>
          <h2 className="mb-2 text-sm font-semibold text-neutral-900">New package</h2>
          <ActionForm
            action={createPackageAction}
            ariaLabel="New package"
            success="Package created"
            resetOnSuccess
            className={CARD}
          >
            <PackageFields
              defaults={{
                name: "",
                description: "",
                monthlyPricePence: 0,
                setupPricePence: 0,
                includes: schema.PACKAGE_INCLUDES_DEFAULT,
              }}
            />
            <label className={LABEL}>
              Slug
              <input
                name="slug"
                required
                maxLength={80}
                pattern="[a-z0-9-]+"
                placeholder="website-care"
                className={FIELD}
              />
            </label>
            <div className="flex justify-end">
              <Button type="submit">Create package</Button>
            </div>
          </ActionForm>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-neutral-900">Existing packages</h2>
          {packages.length === 0 ? (
            <EmptyState>No packages yet. The first one above becomes a client&rsquo;s retainer.</EmptyState>
          ) : (
            packages.map((pkg) => (
              <ActionForm
                key={pkg.id}
                action={updatePackageAction}
                ariaLabel={`Package ${pkg.name}`}
                success="Package saved"
                className={CARD}
              >
                <input type="hidden" name="packageId" value={pkg.id} />
                <p className="text-sm font-medium text-neutral-900">
                  {pkg.name} <span className="font-normal text-neutral-400">/{pkg.slug}</span>
                </p>
                <PackageFields
                  defaults={{
                    name: pkg.name,
                    description: pkg.description ?? "",
                    monthlyPricePence: pkg.monthlyPricePence,
                    setupPricePence: pkg.setupPricePence,
                    includes: pkg.includes,
                  }}
                />
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-sm text-neutral-700">
                    <input
                      type="checkbox"
                      name="active"
                      defaultChecked={pkg.active}
                      className="h-4 w-4 rounded border-neutral-300"
                    />
                    Active
                  </label>
                  <Button type="submit" variant="outline">
                    Save
                  </Button>
                </div>
              </ActionForm>
            ))
          )}
        </section>
      </div>
    </>
  );
}
