"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import type { FieldError } from "react-hook-form";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { SelectField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { createDnsRecordAction } from "../actions";
import { NewDnsRecordSchema, type NewDnsRecordValues } from "../schemas";

const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"].map((value) => ({ value, label: value }));

export function AddDnsRecordForm({ domainId }: { domainId: string }) {
  const router = useRouter();
  const defaults: NewDnsRecordValues = { domainId, type: "A", name: "@", value: "", ttl: 3600 };
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<NewDnsRecordValues>({
    resolver: zodResolver(NewDnsRecordSchema),
    defaultValues: defaults,
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-5"
      onSubmit={handleSubmit(async (values) => {
        const result = await createDnsRecordAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("DNS record saved");
        reset(defaults);
        router.refresh();
      })}
    >
      <input type="hidden" {...register("domainId")} />
      <SelectField name="type" label="Type" register={register} error={errors.type} options={TYPES} />
      <TextField name="name" label="Record name" register={register} error={errors.name} required />
      <TextField name="value" label="Value" register={register} error={errors.value} required />
      {/* z.coerce.number() makes react-hook-form widen this field's error to
          Merge<FieldError, FieldErrorsImpl<{}>> even though ttl is a scalar;
          narrow it back so it satisfies form-fields.tsx's FieldError prop. */}
      <TextField name="ttl" label="TTL" type="number" register={register} error={errors.ttl as FieldError | undefined} />
      <div className="flex items-end">
        <Button type="submit" disabled={isSubmitting} className="w-full">
          Add record
        </Button>
      </div>
    </form>
  );
}
