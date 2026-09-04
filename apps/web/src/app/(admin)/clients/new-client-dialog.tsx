"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { createClientAction } from "./actions";
import { NewClientSchema, type NewClientValues } from "./schemas";

export function NewClientDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
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
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Creating…" : "Create client"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
