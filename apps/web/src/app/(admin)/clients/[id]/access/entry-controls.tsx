"use client";

import { Check, Copy, Eye, EyeOff, Pencil, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { deleteAccessEntryAction, revealAccessSecretAction } from "./actions";
import { EditAccessDialog, type EditableEntry, type Option } from "./entry-form";

/** How long a revealed password stays on the screen. */
export const REVEAL_SECONDS = 30;
const COPIED_MS = 1500;

/** An icon button that puts `value` on the clipboard and says so. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={`Copy ${label}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success(`${label} copied`);
        } catch {
          toast.error("Could not copy — the browser refused clipboard access.");
        }
      }}
    >
      {copied ? <Check aria-hidden className="text-success-fg" /> : <Copy aria-hidden />}
    </Button>
  );
}

/**
 * The password cell. Nothing is on the page until Reveal is pressed; the
 * server action then records the reveal and hands the plaintext back, and it
 * is shown for `REVEAL_SECONDS` with a copy button before it is dropped from
 * state. Hide drops it sooner. The row's "Last viewed" line is server-rendered,
 * so a refresh is requested after the reveal to bring it up to date.
 */
export function RevealSecret({ entryId, clientId, hasSecret, canReveal }: { entryId: string; clientId: string; hasSecret: boolean; canReveal: boolean }) {
  const router = useRouter();
  const [secret, setSecret] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(REVEAL_SECONDS);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (secret === null) return;
    const tick = setInterval(() => {
      setSecondsLeft((n) => {
        if (n <= 1) {
          setSecret(null);
          return REVEAL_SECONDS;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [secret]);

  if (!hasSecret) return <span className="text-muted-foreground">—</span>;
  if (!canReveal) return <span aria-label="Password held" className="tracking-widest text-muted-foreground">••••••••</span>;

  if (secret !== null) {
    return (
      <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
        <code data-testid="revealed-secret" className="rounded-md border bg-muted px-2 py-1 font-mono text-[0.8125rem] break-all select-all">{secret}</code>
        <CopyButton value={secret} label="password" />
        <Button type="button" variant="ghost" size="sm" onClick={() => { setSecret(null); setSecondsLeft(REVEAL_SECONDS); }}>
          <EyeOff aria-hidden />Hide
        </Button>
        <span className="text-meta text-muted-foreground tabular-nums" aria-live="polite">hides in {secondsLeft}s</span>
      </span>
    );
  }

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        const result = await revealAccessSecretAction({ entryId, clientId });
        setBusy(false);
        if (result.status === "error") return void toast.error(result.message);
        setSecondsLeft(REVEAL_SECONDS);
        setSecret(result.secret);
        router.refresh();
      }}
    >
      <Eye aria-hidden />Reveal
    </Button>
  );
}

/** Edit and Delete for one row, each behind its own dialog. */
export function EntryActions({ entry, kinds, sites }: { entry: EditableEntry; kinds: readonly Option[]; sites: readonly Option[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <div className="flex items-center justify-end gap-2 max-sm:flex-col max-sm:[&>*]:w-full">
      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)} aria-label={`Edit ${entry.label}`}>
        <Pencil aria-hidden />Edit
      </Button>
      <Button type="button" variant="destructive-quiet" size="sm" onClick={() => setDeleting(true)} aria-label={`Delete ${entry.label}`}>
        <Trash2 aria-hidden />Delete
      </Button>

      <EditAccessDialog entry={entry} kinds={kinds} sites={sites} open={editing} onOpenChange={setEditing} />

      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {entry.label}?</DialogTitle>
            <DialogDescription>
              The address, username and stored password go. The log of who added, changed and revealed it stays.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setDeleting(false)}>Cancel</Button>
            <Button
              type="button"
              variant="destructive"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const result = await deleteAccessEntryAction({ entryId: entry.id, clientId: entry.clientId });
                setBusy(false);
                if (result.status === "error") return void toast.error(result.message);
                toast.success("Access deleted");
                setDeleting(false);
                router.refresh();
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
