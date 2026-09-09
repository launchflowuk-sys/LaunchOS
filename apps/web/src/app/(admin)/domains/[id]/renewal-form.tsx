import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveRenewalAction } from "../actions";

/**
 * Where the renewal date finally gets typed in.
 *
 * `domains.expires_at` has been on the table since the first migration and
 * every screen that shows it has been printing a blank, because nothing in the
 * product could write to it. That is the whole reason a domain could creep up
 * on its renewal unseen — not a missing warning, a missing input.
 *
 * Auto-renew sits beside it rather than being inferred, because it changes
 * what the warning *says*: a domain set to renew needs its card checked, and
 * one that is not needs somebody to go and do it.
 */
export function RenewalForm({
  domainId,
  expiresAt,
  autoRenew,
  registrar,
}: {
  domainId: string;
  expiresAt: Date | null;
  autoRenew: boolean;
  registrar: string | null;
}) {
  // `<input type="date">` wants `yyyy-mm-dd` and nothing else.
  const value = expiresAt ? expiresAt.toISOString().slice(0, 10) : "";

  return (
    <ActionForm action={saveRenewalAction} success="Renewal details saved" ariaLabel="Renewal details">
      <input type="hidden" name="domainId" value={domainId} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="expiresAt">Renewal date</Label>
          <Input id="expiresAt" type="date" name="expiresAt" defaultValue={value} />
          <p className="text-meta text-muted-foreground">
            Whatever the registrar shows. Clearing it stops the reminders.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="registrar">Registrar</Label>
          <Input
            id="registrar"
            name="registrar"
            defaultValue={registrar ?? ""}
            maxLength={100}
            placeholder="Hostinger, GoDaddy…"
          />
          <p className="text-meta text-muted-foreground">Named in the reminder, so you know where to go.</p>
        </div>
      </div>

      <label className="mt-4 flex items-start gap-2.5 rounded-[14px] border p-3.5 text-sm">
        <input
          type="checkbox"
          name="autoRenew"
          defaultChecked={autoRenew}
          className="mt-0.5 size-4 rounded-[4px] border-input accent-primary"
        />
        <span className="min-w-0">
          <span className="block font-medium">Set to auto-renew</span>
          <span className="block text-meta text-muted-foreground">
            You are still warned either way — auto-renew fails on an expired card, and &ldquo;it was set to
            renew&rdquo; is what people say after a domain lapses.
          </span>
        </span>
      </label>

      <div className="mt-4 flex justify-end">
        <Button type="submit" variant="secondary">Save</Button>
      </div>
    </ActionForm>
  );
}
