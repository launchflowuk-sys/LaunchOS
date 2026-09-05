"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { createClientAction } from "./actions";
import { NewClientSchema, type NewClientValues } from "./schemas";

/**
 * The package options arrive as a prop rather than from `listPackages`:
 * `@launchos/core` reaches `@launchos/db` and the postgres driver, which cannot
 * be bundled for the browser, and this is a client component.
 */
export function NewClientDialog({ packages }: { packages: { value: string; label: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const packageId = useId();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<NewClientValues>({ resolver: zodResolver(NewClientSchema), defaultValues: { name: "" } });

  async function onSubmit(values: NewClientValues) {
    const result = await createClientAction(values);
    if (result.status === "error") {
      toast.error(result.message);
      return;
    }
    toast.success(`${values.name} created`);
    setOpen(false);
    reset();
    router.push(`/clients/${result.id}`);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>New client</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New client</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <TextField name="name" label="Name" register={register} error={errors.name} required />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="email" label="Email" type="email" register={register} error={errors.email} />
            <TextField name="phone" label="Phone" register={register} error={errors.phone} />
          </div>
          <TextField name="addressLine1" label="Address line 1" register={register} error={errors.addressLine1} />
          <TextField name="addressLine2" label="Address line 2" register={register} error={errors.addressLine2} />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="city" label="City" register={register} error={errors.city} />
            <TextField name="postcode" label="Postcode" register={register} error={errors.postcode} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField name="websiteUrl" label="Website" placeholder="https://" register={register} error={errors.websiteUrl} />
            <TextField name="industry" label="Industry" register={register} error={errors.industry} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={packageId}>Package</Label>
            <NativeSelect id={packageId} defaultValue="" {...register("packageId")}>
              <option value="">No package</option>
              {packages.map((pkg) => (
                <option key={pkg.value} value={pkg.value}>
                  {pkg.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={isSubmitting}>
              Create client
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
