"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { SelectField, TextAreaField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { createProjectAction } from "./actions";
import { CreateProjectSchema, type CreateProjectValues, PROJECT_STATUS_LABEL, PROJECT_STATUSES } from "./schemas";

/**
 * Starting a build by hand.
 *
 * Most projects arrive from an accepted proposal — the worker creates those,
 * with the deliverables already turned into milestones — so this form is the
 * other door: the job that was agreed on a phone call, or the one that started
 * before proposals existed. It asks for as little as core will accept and
 * nothing else; the spine, the case study draft and the milestones are added
 * on the detail page.
 */
export function NewProjectForm({ clients }: { clients: readonly { id: string; name: string }[] }) {
  const router = useRouter();
  const empty: CreateProjectValues = { clientId: clients[0]?.id ?? "", name: "", status: "planned" };
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<CreateProjectValues>({
    resolver: zodResolver(CreateProjectSchema),
    defaultValues: empty,
  });

  return (
    <form
      className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      onSubmit={handleSubmit(async (values) => {
        const result = await createProjectAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Project started");
        reset(empty);
        if (result.id) router.push(`/projects/${result.id}`);
        else router.refresh();
      })}
    >
      <SelectField
        name="clientId"
        label="Client"
        register={register}
        error={errors.clientId}
        options={clients.map((client) => ({ value: client.id, label: client.name }))}
      />
      <TextField name="name" label="Project" placeholder="Website and booking system" register={register} error={errors.name} required />
      <SelectField
        name="status"
        label="Status"
        register={register}
        error={errors.status}
        options={PROJECT_STATUSES.map((status) => ({ value: status, label: PROJECT_STATUS_LABEL[status] }))}
      />
      <TextField name="targetDate" label="Target date" type="date" register={register} error={errors.targetDate} />
      <div className="sm:col-span-2 lg:col-span-3">
        <TextAreaField name="summary" label="Summary" placeholder="One or two lines the client will read." register={register} error={errors.summary} />
      </div>
      <div className="flex items-end">
        <Button type="submit" loading={isSubmitting} className="w-full">
          Start project
        </Button>
      </div>
    </form>
  );
}
