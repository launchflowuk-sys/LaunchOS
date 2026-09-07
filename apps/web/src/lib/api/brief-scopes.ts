import type { OpsMetricsSnapshot, PermissionKey } from "@launchos/core";

/**
 * Which permission gates which part of the morning brief.
 *
 * Spec point 14: staff see what they are permitted to see, and the keys are the
 * ones the admin already uses. A second vocabulary invented for the API would
 * be a second place to get permissions wrong, and the two would drift the first
 * time someone changed one of them.
 *
 * Note what is *not* here: `access`. The access vault is passwords, and there
 * is no summary of it that belongs in a brief — not a count, not an age. A
 * number about credentials is still a fact about credentials.
 */
const SECTION_SCOPE = {
  cases: "support",
  tasks: "support",
  incidents: "support",
  leads: "support",
  projects: "support",
  content: "content",
  invoices: "billing",
  packages: "billing",
  approvals: "approvals",
  agents: "settings",
  team: "settings",
} as const satisfies Partial<Record<keyof OpsMetricsSnapshot, PermissionKey>>;

type Section = keyof typeof SECTION_SCOPE;

export interface ScopedBrief {
  /** The window is context rather than data, so it is always present. */
  readonly window: OpsMetricsSnapshot["window"];
  readonly sections: Partial<Omit<OpsMetricsSnapshot, "window">>;
  /**
   * Sections this token could not see.
   *
   * **This list is the point.** Without it, a token scoped to `billing` alone
   * receives a brief with no `cases` key and has no way to tell "nothing
   * happened in support" from "you were not allowed to look". An assistant
   * reading that would cheerfully report a quiet morning during an outage.
   * Absence must never be reported as zero, so the omission is stated.
   */
  readonly omitted: readonly Section[];
}

export function scopeBrief(snapshot: OpsMetricsSnapshot, scopes: readonly PermissionKey[]): ScopedBrief {
  const sections: Record<string, unknown> = {};
  const omitted: Section[] = [];

  for (const [section, required] of Object.entries(SECTION_SCOPE) as [Section, PermissionKey][]) {
    if (scopes.includes(required)) sections[section] = snapshot[section];
    else omitted.push(section);
  }

  return { window: snapshot.window, sections: sections as ScopedBrief["sections"], omitted };
}
