import { listPackages } from "@launchos/core";
import { schema } from "@launchos/db";
import { Package } from "lucide-react";
import { ActionForm } from "@/components/action-form";
import { EmptyState, PageHeader } from "@/components/page-header";
import { Disclosure } from "@/components/disclosure";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/session";
import { createPackageAction, updatePackageAction } from "./actions";
import { PackageFields } from "./package-fields";

export const dynamic = "force-dynamic";

const CARD = "space-y-4 rounded-[20px] border bg-card p-5 sm:p-6";

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
              <Disclosure
                key={pkg.id}
                summary={
                  <span className="text-base font-semibold">
                    {pkg.name}{" "}
                    <span className="font-mono text-meta font-normal text-muted-foreground">/{pkg.slug}</span>
                  </span>
                }
                meta={pkg.active ? undefined : "Inactive"}
              >
              <ActionForm
                action={updatePackageAction}
                ariaLabel={`Package ${pkg.name}`}
                success="Package saved"
                className="space-y-4"
              >
                <input type="hidden" name="packageId" value={pkg.id} />
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
                <div className="space-y-1.5 sm:max-w-sm">
                  <Label htmlFor={`package-${pkg.id}-stripePriceId`}>Stripe price id</Label>
                  <Input
                    id={`package-${pkg.id}-stripePriceId`}
                    name="stripePriceId"
                    defaultValue={pkg.stripePriceId ?? ""}
                    placeholder="price_…"
                    maxLength={200}
                    className="font-mono"
                  />
                  <p className="text-meta text-muted-foreground">
                    Lets people buy this package on /signup by card. Leave blank and sign-up invoices them instead.
                  </p>
                </div>
                {/* Selling this from the client portal. Deliberately three
                    separate decisions rather than one switch: what sort of
                    thing it is decides whether Checkout opens a subscription
                    or a single payment, and a trial is a commitment to do the
                    work before any money arrives. */}
                <div className="grid gap-4 border-t pt-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor={`package-${pkg.id}-kind`}>Sold as</Label>
                    <select
                      id={`package-${pkg.id}-kind`}
                      name="kind"
                      defaultValue={pkg.kind}
                      className="h-12 w-full rounded-[14px] border bg-transparent px-3 text-sm"
                    >
                      <option value="retainer">Monthly retainer</option>
                      <option value="one_off">One-off job</option>
                      <option value="addon">Add-on</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`package-${pkg.id}-trialDays`}>Free trial (days)</Label>
                    <Input
                      id={`package-${pkg.id}-trialDays`}
                      type="number"
                      name="trialDays"
                      min={0}
                      max={365}
                      defaultValue={pkg.trialDays}
                      className="tabular-nums"
                    />
                    <p className="text-meta text-muted-foreground">
                      Zero means pay now. Onboarding starts either way.
                    </p>
                  </div>
                </div>

                <label className="flex items-start gap-2.5 rounded-[14px] border p-3.5 text-sm">
                  <input
                    type="checkbox"
                    name="selfServe"
                    defaultChecked={pkg.selfServe}
                    className="mt-0.5 size-4 rounded-[4px] border-input accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">Clients can buy this themselves</span>
                    <span className="block text-meta text-muted-foreground">
                      Shows it under Add a service in the portal. Needs a Stripe price id above — without one it
                      stays hidden rather than failing at checkout.
                    </span>
                  </span>
                </label>

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
              </Disclosure>
            ))}
          </div>
        )}
      </Section>
    </>
  );
}
