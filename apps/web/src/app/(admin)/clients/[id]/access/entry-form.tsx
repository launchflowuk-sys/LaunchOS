"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { useForm, type FieldErrors, type UseFormRegister } from "react-hook-form";
import { toast } from "sonner";
import { SelectField, TextAreaField, TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createAccessEntryAction, updateAccessEntryAction } from "./actions";
import {
  EditAccessEntrySchema, NewAccessEntrySchema, type EditAccessEntryValues, type NewAccessEntryValues,
} from "./schemas";

export type Option = { value: string; label: string };

/** What the edit dialog is handed: the entry as the list shows it, never the secret. */
export type EditableEntry = {
  id: string;
  clientId: string;
  kind: string;
  label: string;
  url: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  siteId: string | null;
  notes: string | null;
  hasSecret: boolean;
};

type Values = NewAccessEntryValues | EditAccessEntryValues;

/**
 * The nine fields, shared by Add and Edit. `secretField` is written out rather
 * than through `TextField` so the input can carry `autoComplete="new-password"`
 * — without it a browser offers to fill the client's server password from the
 * operator's own saved logins, or to save it.
 */
function EntryFields<T extends Values>({
  register, errors, kinds, sites, secretHint,
}: {
  register: UseFormRegister<T>;
  errors: FieldErrors<T>;
  kinds: readonly Option[];
  sites: readonly Option[];
  secretHint: string;
}) {
  const secretId = useId();
  // The generic form's errors are typed on T; every field below exists on both value types.
  const e = errors as FieldErrors<EditAccessEntryValues>;
  const r = register as unknown as UseFormRegister<EditAccessEntryValues>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <SelectField name="kind" label="Kind" register={r} error={e.kind} options={kinds} />
      <TextField name="label" label="Label" placeholder="Hetzner CX22, WP admin…" register={r} error={e.label} required />
      <div className="sm:col-span-2">
        <TextField name="url" label="URL" placeholder="https://" register={r} error={e.url} />
      </div>
      <TextField name="host" label="Host or IP" placeholder="88.198.0.1" register={r} error={e.host} />
      <TextField name="port" label="Port" type="number" placeholder="22" register={r} error={e.port} />
      <TextField name="username" label="Username" register={r} error={e.username} />
      <div className="space-y-1.5">
        <Label htmlFor={secretId}>Password or key</Label>
        <Input id={secretId} type="password" autoComplete="new-password" aria-invalid={e.secret ? true : undefined} {...r("secret")} />
        <p className="text-meta text-muted-foreground">{secretHint}</p>
        {e.secret ? <p role="alert" className="text-meta text-danger-fg">{e.secret.message}</p> : null}
      </div>
      <div className="sm:col-span-2">
        <SelectField name="siteId" label="Website" register={r} error={e.siteId} options={[{ value: "", label: "Not tied to a website" }, ...sites]} />
      </div>
      <div className="sm:col-span-2">
        <TextAreaField name="notes" label="Notes" placeholder="Port 2222 not 22; the MySQL user is read-only…" register={r} error={e.notes} />
        <p className="mt-1 text-meta text-muted-foreground">Notes are stored in plain text. No passwords in here — use the field above.</p>
      </div>
    </div>
  );
}

const NEW_DEFAULTS = { kind: "dashboard", label: "", url: "", host: "", port: "", username: "", secret: "", siteId: "", notes: "" } as const;

/** "Add access" in the page header: the form in a dialog, reset on every open. */
export function AddAccessDialog({ clientId, kinds, sites }: { clientId: string; kinds: readonly Option[]; sites: readonly Option[] }) {
  const [open, setOpen] = useState(false);
  const [round, setRound] = useState(0);
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setRound((n) => n + 1); }}>
      <Button type="button" onClick={() => setOpen(true)}><KeyRound aria-hidden />Add access</Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add access</DialogTitle>
          <DialogDescription>A dashboard, a server, a database — where it is and how we get in.</DialogDescription>
        </DialogHeader>
        <AddAccessForm key={round} clientId={clientId} kinds={kinds} sites={sites} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function AddAccessForm({ clientId, kinds, sites, onDone }: { clientId: string; kinds: readonly Option[]; sites: readonly Option[]; onDone: () => void }) {
  const router = useRouter();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<NewAccessEntryValues>({
    resolver: zodResolver(NewAccessEntrySchema),
    defaultValues: { clientId, ...NEW_DEFAULTS },
  });
  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit(async (values) => {
        const result = await createAccessEntryAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Access added");
        onDone();
        router.refresh();
      })}
    >
      <input type="hidden" {...register("clientId")} />
      <EntryFields register={register} errors={errors} kinds={kinds} sites={sites} secretHint="Optional. Encrypted before it is stored; shown again only through Reveal." />
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" loading={isSubmitting}>Save access</Button>
      </DialogFooter>
    </form>
  );
}

/** The same form prefilled, minus the password, with a tick to remove the stored one. */
export function EditAccessDialog({
  entry, kinds, sites, open, onOpenChange,
}: { entry: EditableEntry; kinds: readonly Option[]; sites: readonly Option[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {entry.label}</DialogTitle>
          <DialogDescription>An emptied field clears that detail. The stored password stays unless you replace or remove it.</DialogDescription>
        </DialogHeader>
        {open ? <EditAccessForm entry={entry} kinds={kinds} sites={sites} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function EditAccessForm({ entry, kinds, sites, onDone }: { entry: EditableEntry; kinds: readonly Option[]; sites: readonly Option[]; onDone: () => void }) {
  const router = useRouter();
  const clearId = useId();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<EditAccessEntryValues>({
    resolver: zodResolver(EditAccessEntrySchema),
    defaultValues: {
      entryId: entry.id,
      clientId: entry.clientId,
      kind: entry.kind as EditAccessEntryValues["kind"],
      label: entry.label,
      url: entry.url ?? "",
      host: entry.host ?? "",
      port: entry.port === null ? "" : String(entry.port),
      username: entry.username ?? "",
      secret: "",
      siteId: entry.siteId ?? "",
      notes: entry.notes ?? "",
      clearSecret: false,
    },
  });
  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit(async (values) => {
        const result = await updateAccessEntryAction(values);
        if (result.status === "error") return void toast.error(result.message);
        toast.success("Access updated");
        onDone();
        router.refresh();
      })}
    >
      <input type="hidden" {...register("entryId")} />
      <input type="hidden" {...register("clientId")} />
      <EntryFields
        register={register}
        errors={errors}
        kinds={kinds}
        sites={sites}
        secretHint={entry.hasSecret ? "Leave blank to keep the stored password; type a new one to replace it." : "None stored. Optional."}
      />
      {entry.hasSecret ? (
        <Label htmlFor={clearId} className="gap-2">
          <input id={clearId} type="checkbox" className="size-4 rounded-[4px] border border-input accent-primary" {...register("clearSecret")} />
          Remove the stored password
        </Label>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="secondary" onClick={onDone}>Cancel</Button>
        <Button type="submit" loading={isSubmitting}>Save changes</Button>
      </DialogFooter>
    </form>
  );
}
