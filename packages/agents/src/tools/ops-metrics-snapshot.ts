import { opsMetricsSnapshot, type OpsMetricsSnapshot } from "@launchos/core";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

const Input = z.object({
  hours: z.number().int().min(1).max(24 * 14).default(24).describe("How far back to look. The morning brief uses 24."),
});

/**
 * The numbers. Every figure the brief quotes comes from here, read from our
 * own rows for the window ending at the run's clock; the prompt forbids
 * quoting anything that is not in this object. Safe: read-only.
 */
export const opsMetricsSnapshotTool = defineTool({
  name: "ops_metrics_snapshot",
  description:
    "The organisation's operating numbers for the last N hours and its open state right now: cases opened/resolved/open " +
    "and median first-response minutes, tasks overdue/completed, incidents, approvals pending, invoices overdue/outstanding/paid " +
    "(in pence), content published/failed, agent runs and failures, and hours the team clocked. Quote only figures from this.",
  input: Input,
  risk: "safe",
  execute: async (input, ctx): Promise<OpsMetricsSnapshot> =>
    opsMetricsSnapshot(ctx.db, ctx.organisationId, { hours: input.hours, now: ctx.now() }),
});
