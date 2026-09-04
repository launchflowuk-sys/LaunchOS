export type Severity = "low" | "medium" | "high" | "critical";

/** Calendar hours from ticket creation. Business-hours SLAs are out of scope for v1. */
export const SLA_HOURS_BY_SEVERITY: Record<Severity, number> = { low: 72, medium: 48, high: 8, critical: 2 };

export function slaDueAt(severity: Severity, from: Date): Date {
  return new Date(from.getTime() + SLA_HOURS_BY_SEVERITY[severity] * 60 * 60 * 1000);
}
