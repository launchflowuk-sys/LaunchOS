import { StatusBadge, type StatusTone } from "@/components/status-badge";

/**
 * Portal wording for the two states a client sees on infrastructure they do not
 * administer.
 *
 * The pill itself is the shared `StatusBadge` — same shape, same colour
 * vocabulary, same dot — driven through its documented `label` and `tone`
 * overrides. Only the words change: "live" and "transferring" are our nouns for
 * our own records, and a small-business owner reading this twice a year should
 * not have to translate them. The `data-status` attribute still carries the
 * stored value, so a selector written against the database word keeps working.
 */
type Presentation = { label: string; tone: StatusTone };

const SITE: Record<string, Presentation> = {
  live: { label: "Online", tone: "success" },
  building: { label: "Being built", tone: "info" },
  paused: { label: "Paused", tone: "warn" },
  archived: { label: "Archived", tone: "neutral" },
};

const DOMAIN: Record<string, Presentation> = {
  active: { label: "Registered", tone: "success" },
  expiring: { label: "Renewing soon", tone: "warn" },
  expired: { label: "Expired", tone: "danger" },
  transferring: { label: "Moving to us", tone: "info" },
};

/** An unknown value keeps the stored word and the calm colour, never a false alarm. */
function Badge({ value, map }: { value: string; map: Record<string, Presentation> }) {
  const presentation = map[value];
  if (!presentation) return <StatusBadge value={value} />;
  return <StatusBadge value={value} label={presentation.label} tone={presentation.tone} />;
}

export function SiteStatusBadge({ value }: { value: string }) {
  return <Badge value={value} map={SITE} />;
}

export function DomainStatusBadge({ value }: { value: string }) {
  return <Badge value={value} map={DOMAIN} />;
}
