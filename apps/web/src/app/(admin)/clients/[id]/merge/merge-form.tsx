"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { mergeClientsAction } from "../../actions";
import { MergeClientsSchema, type MergeClientsValues } from "../../schemas";

/**
 * The last step: type the kept client's name, press Merge. The button stays
 * off until the name matches, and the action checks it again against the
 * database — the form proves the person read the screen; the server proves
 * the record. A refusal is shown as core wrote it; success goes to the kept
 * client with a toast, since that is where everything now lives.
 */
export function MergeForm({ keepId, keepName, mergeId, mergeName, movedSummary }: {
  keepId: string;
  keepName: string;
  mergeId: string;
  mergeName: string;
  /** "3 subscriptions, 1 site" — for the toast. */
  movedSummary: string;
}) {
  const router = useRouter();
  const { register, control, handleSubmit, formState: { errors, isSubmitting } } = useForm<MergeClientsValues>({
    resolver: zodResolver(MergeClientsSchema),
    defaultValues: { keepId, mergeId, confirmName: "" },
  });
  // `useWatch`, not `watch`: the React Compiler skips a component that calls `watch`.
  const typed = useWatch({ control, name: "confirmName" });
  const matches = typed.trim() === keepName.trim();

  return (
    <form
      className="grid gap-4"
      onSubmit={handleSubmit(async (values) => {
        const result = await mergeClientsAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success(`Merged ${mergeName} into ${keepName}`, { description: movedSummary ? `${movedSummary} moved across.` : "Nothing needed moving." });
        router.push(`/clients/${result.id}`);
        router.refresh();
      })}
    >
      <input type="hidden" {...register("keepId")} />
      <input type="hidden" {...register("mergeId")} />
      <div className="max-w-md">
        <TextField
          name="confirmName"
          label={`Type "${keepName}" to confirm`}
          placeholder={keepName}
          register={register}
          error={errors.confirmName}
          required
        />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center max-sm:[&>*]:w-full">
        <Button type="submit" variant="destructive" disabled={!matches} loading={isSubmitting}>
          Merge {mergeName} into {keepName}
        </Button>
        <Button asChild variant="secondary">
          <Link href={`/clients/${mergeId}`}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
