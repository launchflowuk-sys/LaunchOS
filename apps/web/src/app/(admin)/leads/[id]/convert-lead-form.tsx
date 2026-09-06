"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { convertLeadAction } from "../actions";

/**
 * "Convert to client": the client's name (defaulting to the business, then
 * the person) and an optional package. On success the browser goes to the
 * new client — the natural next screen is their record, not the lead — which
 * is why this is a client component around the action rather than an
 * `ActionForm`: a server-side `redirect` would not survive `ActionForm`'s
 * result handling.
 */
export function ConvertLeadForm({
  leadId,
  defaultName,
  packages,
}: {
  leadId: string;
  defaultName: string;
  packages: readonly { value: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(defaultName);
  const [packageId, setPackageId] = useState("");

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      const result = await convertLeadAction({ leadId, name, packageId });
      if (result.status === "error") return void toast.error(result.message);
      toast.success(`${name || defaultName} is now a client`);
      router.push(`/clients/${result.id}`);
    });
  }

  return (
    <form onSubmit={onSubmit} aria-label="Convert to client" className="grid gap-4 rounded-xl border bg-card p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="convert-name">Client name</Label>
          <Input id="convert-name" name="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="convert-package">Package</Label>
          <NativeSelect id="convert-package" name="packageId" value={packageId} onChange={(e) => setPackageId(e.target.value)}>
            <option value="">No package yet</option>
            {packages.map((pkg) => (
              <option key={pkg.value} value={pkg.value}>
                {pkg.label}
              </option>
            ))}
          </NativeSelect>
          <p className="text-meta text-muted-foreground">Optional. Onboarding tasks generate from it as for any new client.</p>
        </div>
      </div>
      <div className="flex sm:justify-end">
        <Button type="submit" loading={pending} className="max-sm:w-full">
          Convert to client
        </Button>
      </div>
    </form>
  );
}
