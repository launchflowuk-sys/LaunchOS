"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { SelectField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  archiveClientAction, createContactAction, createDomainAction, createSiteAction, deleteContactAction, saveBillingAction,
} from "../actions";
import {
  BillingSchema, NewContactSchema, NewDomainSchema, NewSiteSchema,
  type BillingValues, type NewContactValues, type NewDomainValues, type NewSiteValues,
} from "../schemas";

export function AddContactForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const primaryId = useId();
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<NewContactValues>({
    resolver: zodResolver(NewContactSchema),
    defaultValues: { clientId, name: "", isPrimary: false },
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={handleSubmit(async (values) => {
        const result = await createContactAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Contact added");
        reset({ clientId, name: "", isPrimary: false });
        router.refresh();
      })}
    >
      <input type="hidden" {...register("clientId")} />
      <TextField name="name" label="Contact name" register={register} error={errors.name} required />
      <TextField name="email" label="Contact email" type="email" register={register} error={errors.email} />
      <TextField name="phone" label="Contact phone" register={register} error={errors.phone} />
      <div className="flex flex-wrap items-end gap-3">
        <Label htmlFor={primaryId} className="h-9 gap-2 whitespace-nowrap">
          {/* Core demotes any existing primary contact when this one is saved.
              A native checkbox, not the Radix one: react-hook-form's `register`
              needs a real input to read. */}
          <input
            id={primaryId}
            type="checkbox"
            className="size-4 rounded-[4px] border border-input accent-primary"
            {...register("isPrimary")}
          />
          Primary contact
        </Label>
        <Button type="submit" loading={isSubmitting} variant="secondary">
          Add contact
        </Button>
      </div>
    </form>
  );
}

export function AddDomainForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<NewDomainValues>({
    resolver: zodResolver(NewDomainSchema),
    defaultValues: { clientId, name: "", dnsProvider: "other" },
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={handleSubmit(async (values) => {
        const result = await createDomainAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Domain added");
        reset({ clientId, name: "", dnsProvider: "other" });
        router.refresh();
      })}
    >
      <input type="hidden" {...register("clientId")} />
      <TextField name="name" label="Domain name" placeholder="example.co.uk" register={register} error={errors.name} required />
      <TextField name="registrar" label="Registrar" register={register} error={errors.registrar} />
      <SelectField
        name="dnsProvider"
        label="DNS provider"
        register={register}
        error={errors.dnsProvider}
        options={[
          { value: "other", label: "Other" },
          { value: "cloudflare", label: "Cloudflare" },
          { value: "registrar", label: "Registrar" },
        ]}
      />
      <div className="flex items-end">
        <Button type="submit" loading={isSubmitting} variant="secondary" className="w-full">
          Add domain
        </Button>
      </div>
    </form>
  );
}

export function AddSiteForm({ clientId }: { clientId: string }) {
  const router = useRouter();
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<NewSiteValues>({
    resolver: zodResolver(NewSiteSchema),
    defaultValues: { clientId, name: "", primaryUrl: "", platform: "wordpress" },
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={handleSubmit(async (values) => {
        const result = await createSiteAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Website added");
        reset({ clientId, name: "", primaryUrl: "", platform: "wordpress" });
        router.refresh();
      })}
    >
      <input type="hidden" {...register("clientId")} />
      <TextField name="name" label="Website name" register={register} error={errors.name} required />
      <TextField name="primaryUrl" label="Primary URL" placeholder="https://" register={register} error={errors.primaryUrl} required />
      <SelectField
        name="platform"
        label="Platform"
        register={register}
        error={errors.platform}
        options={[
          { value: "wordpress", label: "WordPress" },
          { value: "nextjs", label: "Next.js" },
          { value: "static", label: "Static" },
          { value: "other", label: "Other" },
        ]}
      />
      <div className="flex items-end">
        <Button type="submit" loading={isSubmitting} variant="secondary" className="w-full">
          Add website
        </Button>
      </div>
    </form>
  );
}

export function BillingForm({ clientId, defaults }: { clientId: string; defaults: Omit<BillingValues, "clientId"> }) {
  const router = useRouter();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<BillingValues>({
    resolver: zodResolver(BillingSchema),
    defaultValues: { clientId, ...defaults },
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={handleSubmit(async (values) => {
        const result = await saveBillingAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Billing details saved");
        router.refresh();
      })}
    >
      <input type="hidden" {...register("clientId")} />
      <TextField name="billingName" label="Billing name" register={register} error={errors.billingName} />
      <TextField name="vatNumber" label="VAT number" register={register} error={errors.vatNumber} />
      <TextField name="addressLine1" label="Billing address" register={register} error={errors.addressLine1} />
      <TextField name="city" label="Billing city" register={register} error={errors.city} />
      <TextField name="postcode" label="Billing postcode" register={register} error={errors.postcode} />
      <TextField name="paymentTermsDays" label="Payment terms (days)" type="number" register={register} error={errors.paymentTermsDays} />
      <TextField name="preferredMethod" label="Preferred method" register={register} error={errors.preferredMethod} />
      <div className="flex items-end">
        <Button type="submit" loading={isSubmitting} variant="secondary" className="max-sm:w-full">
          Save billing details
        </Button>
      </div>
    </form>
  );
}

/**
 * Archive and Remove are buttons rather than `<form action>` submits so the
 * action can return a failure the person actually sees, instead of it landing
 * on the error boundary.
 */
export function ArchiveClientButton({ clientId, disabled }: { clientId: string; disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      type="button"
      variant="destructive"
      disabled={disabled}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        const result = await archiveClientAction({ clientId });
        setBusy(false);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Client archived");
        router.refresh();
      }}
    >
      Archive
    </Button>
  );
}

export function RemoveContactButton({ clientId, contactId }: { clientId: string; contactId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      type="button"
      size="sm"
      variant="destructive"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        const result = await deleteContactAction({ clientId, contactId });
        setBusy(false);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Contact removed");
        router.refresh();
      }}
    >
      Remove
    </Button>
  );
}
