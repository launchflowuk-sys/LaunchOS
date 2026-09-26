"use client";

import { MoreHorizontal } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { redeployAction, serverAction } from "./actions";
import { BUSY_LABEL } from "./labels";

/**
 * A command this menu can send. Deliberately a small, closed set — the six
 * `SERVER_COMMANDS` core accepts. Hard power-off, reset, delete, rebuild and
 * rescale do not exist here because core has no tool for them: this menu is
 * not a general Hetzner console.
 */
type Command = "reboot" | "shutdown" | "poweron" | "create_image" | "enable_backup" | "disable_backup";

const NAMED = new Set<Command>(["reboot", "shutdown"]);

const LABEL: Record<Command, string> = {
  reboot: "Reboot",
  shutdown: "Shut down",
  poweron: "Power on",
  create_image: "Take snapshot",
  enable_backup: "Turn on backups",
  disable_backup: "Turn off backups",
};

function noteFor(command: Command, monthlyBaseCents: number): string | null {
  if (command === "create_image") return "Costs about €0.0143 per GB per month while kept.";
  if (command === "enable_backup") return `+20% — about €${((monthlyBaseCents * 0.2) / 100).toFixed(2)}/month.`;
  return null;
}

export function ServerActionsMenu({
  serverId,
  serverName,
  status,
  backupsEnabled,
  monthlyBaseCents,
  pendingCommand,
}: {
  serverId: string;
  serverName: string;
  status: string;
  backupsEnabled: boolean;
  /**
   * The server's projected *base* price for the full month, in EUR cents —
   * `cost.projectedMonth` less the variable components (backups, volumes,
   * IPv4, snapshots, traffic). Feeds the "turn on backups" cost note. Not
   * `cost.monthToDate`: that is only what has accrued so far this month, so
   * early in the month it understates the backups uplift to near zero.
   */
  monthlyBaseCents: number;
  /** `server.pendingAction?.command`, if Hetzner is already mid-action on this server. */
  pendingCommand?: string | null | undefined;
}) {
  const [open, setOpen] = useState<Command | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [isPending, startTransition] = useTransition();

  const running = status === "running";
  const commands: Command[] = [
    ...(running ? (["reboot", "shutdown"] as const) : (["poweron"] as const)),
    "create_image",
    backupsEnabled ? "disable_backup" : "enable_backup",
  ];

  function run(command: Command, confirmName?: string) {
    startTransition(async () => {
      const result = await serverAction(serverId, command, confirmName);
      if (!result.ok) return void toast.error(result.message);
      toast.success(result.message);
      setOpen(null);
      setConfirmText("");
    });
  }

  // The row's status badge already says what is running; the menu just locks.
  if (pendingCommand) {
    const busy = BUSY_LABEL[pendingCommand] ?? "Busy";
    return (
      <Button type="button" variant="ghost" size="icon" className="size-8" disabled title={busy}>
        <MoreHorizontal className="size-4" />
        <span className="sr-only">Server actions — {busy}</span>
      </Button>
    );
  }

  const requiresName = open ? NAMED.has(open) : false;
  const confirmDisabled = isPending || (requiresName && confirmText.trim() !== serverName);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="size-8">
            <MoreHorizontal className="size-4" />
            <span className="sr-only">Server actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {commands.map((command) => (
            <DropdownMenuItem
              key={command}
              onSelect={() => {
                setConfirmText("");
                setOpen(command);
              }}
            >
              {LABEL[command]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent>
          {open ? (
            <>
              <DialogHeader>
                <DialogTitle>{LABEL[open]} — {serverName}</DialogTitle>
                <DialogDescription>
                  {noteFor(open, monthlyBaseCents) ?? `This is sent straight to Hetzner for ${serverName}.`}
                </DialogDescription>
              </DialogHeader>
              {requiresName ? (
                <div className="space-y-1.5">
                  <label htmlFor="confirm-server-name" className="text-sm font-medium">
                    Type <span className="font-mono">{serverName}</span> to confirm
                  </label>
                  <Input
                    id="confirm-server-name"
                    autoFocus
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                  />
                </div>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => setOpen(null)}>
                  Cancel
                </Button>
                <Button type="button" loading={isPending} disabled={confirmDisabled} onClick={() => run(open, confirmText)}>
                  {LABEL[open]}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A small "Redeploy" button beside a Coolify application, with a plain browser confirm — not the dialog above, which is for named-server-destroying actions. */
export function RedeployButton({ connectionId, appUuid, appName }: { connectionId: string; appUuid: string; appName: string }) {
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs"
      loading={isPending}
      onClick={() => {
        if (!window.confirm(`Redeploy ${appName}?`)) return;
        startTransition(async () => {
          const result = await redeployAction(connectionId, appUuid, appName);
          if (!result.ok) return void toast.error(result.message);
          toast.success(result.message);
        });
      }}
    >
      Redeploy
    </Button>
  );
}
