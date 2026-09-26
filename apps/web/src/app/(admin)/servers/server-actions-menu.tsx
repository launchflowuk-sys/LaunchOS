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

export const BUSY_LABEL: Record<string, string> = {
  reboot: "Rebooting…",
  shutdown: "Shutting down…",
  poweron: "Powering on…",
  create_image: "Taking snapshot…",
  enable_backup: "Turning on backups…",
  disable_backup: "Turning off backups…",
};

function noteFor(command: Command, monthlyCents: number): string | null {
  if (command === "create_image") return "Costs about €0.0143 per GB per month while kept.";
  if (command === "enable_backup") return `+20% — about €${((monthlyCents * 0.2) / 100).toFixed(2)}/month.`;
  return null;
}

export function ServerActionsMenu({
  serverId,
  serverName,
  status,
  backupsEnabled,
  monthlyCents,
  pendingCommand,
}: {
  serverId: string;
  serverName: string;
  status: string;
  backupsEnabled: boolean;
  /** The server's `cost.monthToDate` in EUR cents — feeds the snapshot/backup cost notes. */
  monthlyCents: number;
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

  if (pendingCommand) {
    return (
      <Button type="button" variant="secondary" size="sm" disabled>
        {BUSY_LABEL[pendingCommand] ?? "Busy"}
      </Button>
    );
  }

  const requiresName = open ? NAMED.has(open) : false;
  const confirmDisabled = isPending || (requiresName && confirmText.trim() !== serverName);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* Also inside the row's `<summary>` — stop the click from toggling
              the cost breakdown open at the same time as the menu. */}
          <Button type="button" variant="ghost" size="icon" className="size-8" onClick={(event) => event.stopPropagation()}>
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
                  {noteFor(open, monthlyCents) ?? `This is sent straight to Hetzner for ${serverName}.`}
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
      onClick={(event) => {
        event.stopPropagation();
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
