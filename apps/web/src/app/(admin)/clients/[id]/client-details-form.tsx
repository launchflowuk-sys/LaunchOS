"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { TextAreaField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { updateClientDetailsAction } from "../actions";
import { ClientDetailsSchema, type ClientDetailsValues } from "../schemas";

/**
 * "Edit details" on the Overview tab: the name, trading name, contact and
 * address fields core's `updateClient` accepts. The same react-hook-form
 * shape as the billing form, so the two editors on a client read alike; an
 * emptied field clears the column (see `ClientDetailsSchema`).
 */
export function ClientDetailsForm({ clientId, defaults }: { clientId: string; defaults: Omit<ClientDetailsValues, "clientId"> }) {
  const router = useRouter();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ClientDetailsValues>({
    resolver: zodResolver(ClientDetailsSchema),
    defaultValues: { clientId, ...defaults },
  });

  return (
    <form
      aria-label="Client details"
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={handleSubmit(async (values) => {
        const result = await updateClientDetailsAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Client details saved");
        router.refresh();
      })}
    >
      <input type="hidden" {...register("clientId")} />
      <TextField name="name" label="Client name" register={register} error={errors.name} required />
      <TextField name="tradingName" label="Trading name" register={register} error={errors.tradingName} />
      <TextField name="email" label="Email" type="email" register={register} error={errors.email} />
      <TextField name="phone" label="Phone" register={register} error={errors.phone} />
      <TextField name="websiteUrl" label="Website" placeholder="https://" register={register} error={errors.websiteUrl} />
      <TextField name="industry" label="Industry" register={register} error={errors.industry} />
      <TextField name="addressLine1" label="Address line 1" register={register} error={errors.addressLine1} />
      <TextField name="addressLine2" label="Address line 2" register={register} error={errors.addressLine2} />
      <TextField name="city" label="City" register={register} error={errors.city} />
      <TextField name="postcode" label="Postcode" register={register} error={errors.postcode} />
      <div className="sm:col-span-2">
        <TextAreaField name="notes" label="Notes" register={register} error={errors.notes} placeholder="Anything the team should know about this client." />
      </div>
      <div className="flex items-end sm:col-span-2 sm:justify-end">
        <Button type="submit" loading={isSubmitting} variant="secondary" className="max-sm:w-full">
          Save details
        </Button>
      </div>
    </form>
  );
}
