import { CircleAlert, CircleCheck, Info, type LucideIcon, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * An inline warning on a row or a detail page: a send that failed, portal access
 * that was revoked, an account that has disconnected.
 *
 * It uses the same semantic trio as StatusBadge, so the red on an alert and the
 * red on a pill are the one red. `danger` and `warning` are announced; `info`
 * and `success` are not, because a page that shouts every confirmation trains
 * the reader to ignore it.
 */
const TONES: Record<InlineAlertTone, { box: string; ink: string; icon: LucideIcon }> = {
  info: { box: "border-info-border bg-info-bg", ink: "text-info-fg", icon: Info },
  success: { box: "border-success-border bg-success-bg", ink: "text-success-fg", icon: CircleCheck },
  warning: { box: "border-warning-border bg-warning-bg", ink: "text-warning-fg", icon: TriangleAlert },
  danger: { box: "border-danger-border bg-danger-bg", ink: "text-danger-fg", icon: CircleAlert },
};

export type InlineAlertTone = "info" | "success" | "warning" | "danger";

export function InlineAlert({
  tone = "info",
  title,
  children,
  action,
  className,
}: {
  tone?: InlineAlertTone;
  title?: string;
  children?: ReactNode;
  /** One control: "Retry", "Reissue access". Full width under `sm`. */
  action?: ReactNode;
  className?: string;
}) {
  const { box, ink, icon: Icon } = TONES[tone];
  const isUrgent = tone === "danger" || tone === "warning";

  return (
    <div
      role={isUrgent ? "alert" : "note"}
      className={cn("flex flex-col gap-3 rounded-xl border p-3 sm:flex-row sm:items-start", box, className)}
    >
      <Icon aria-hidden strokeWidth={1.75} className={cn("size-4 shrink-0 sm:mt-0.5", ink)} />
      <div className="min-w-0 flex-1 text-sm">
        {title ? <p className={cn("font-semibold", ink)}>{title}</p> : null}
        {children ? <div className={cn(title ? "mt-0.5" : "", ink)}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 max-sm:[&>*]:w-full">{action}</div> : null}
    </div>
  );
}
