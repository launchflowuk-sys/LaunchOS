import { Badge } from "@/components/ui/badge";

const TONES = {
  neutral: "border-neutral-300 bg-neutral-100 text-neutral-700",
  info: "border-blue-200 bg-blue-50 text-blue-700",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  danger: "border-red-200 bg-red-50 text-red-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
} as const;

type Tone = keyof typeof TONES;

const TONE_BY_VALUE: Record<string, Tone> = {
  // incident + ticket status
  open: "danger",
  acknowledged: "warn",
  resolved: "success",
  closed: "neutral",
  triaged: "info",
  in_progress: "info",
  waiting_client: "warn",
  // severity
  low: "neutral",
  medium: "info",
  high: "warn",
  critical: "danger",
  // agent run status
  running: "info",
  completed: "success",
  awaiting_approval: "warn",
  failed: "danger",
  // approvals
  pending: "warn",
  approved: "success",
  rejected: "danger",
  // task status
  todo: "neutral",
  blocked: "danger",
  review: "info",
  done: "success",
  cancelled: "neutral",
  // task priority
  urgent: "danger",
  // task phase
  onboarding: "info",
  recurring: "neutral",
  support: "warn",
  // client status
  active: "success",
  paused: "warn",
  archived: "neutral",
};

export function StatusBadge({ value, tone }: { value: string; tone?: Tone }) {
  const resolved = tone ?? TONE_BY_VALUE[value] ?? "neutral";
  return (
    <Badge variant="outline" className={TONES[resolved]}>
      {value.replaceAll("_", " ")}
    </Badge>
  );
}
