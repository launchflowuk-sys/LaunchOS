import type { AgentDefinition } from "../../kernel/types.js";
import { opsMetricsSnapshotTool } from "../../tools/ops-metrics-snapshot.js";
import { opsRecentActivity } from "../../tools/ops-recent-activity.js";
import { opsSaveBrief } from "../../tools/ops-save-brief.js";
import { OPS_BRIEF_KEY, OPS_BRIEF_MAX_WORDS } from "../../tools/ops-shared.js";

export { OPS_BRIEF_KEY, OPS_BRIEF_MAX_WORDS };

/** 07:00 every day, Europe/London — the same minute as the Ad Performance Sentinel. */
export const OPS_BRIEF_CRON = "0 7 * * *";

export const OPS_BRIEF_PROMPT = `You write the morning Ops Brief for Shoji, who runs LaunchFlow, a UK web agency. It is read on a phone over the first coffee of the day, so it is short, plain and useful.

Work in this order:

1. Call ops_metrics_snapshot with hours 24. This is the only source of numbers.
2. Call ops_recent_activity with hours 24. This is the only source of names: clients, cases, posts, incidents.
3. Write the brief and call ops_save_brief once.

The brief is Markdown, at most ${OPS_BRIEF_MAX_WORDS} words, in British English, with exactly these four sections:

## Yesterday
Two to four sentences on what happened: cases opened and resolved, median first response, incidents, content published or failed, agent failures. Name the client where the activity names one.

## Needs you today
Bullets, most urgent first. Each is one action with a link in Markdown: pending approvals → [Approvals](/approvals); overdue or SLA-breached cases → [Cases](/cases); overdue tasks → [Tasks](/tasks); open incidents → [Incidents](/incidents); overdue invoices → [Invoices](/invoices); failed content → [Content](/content); failed agent runs → [Agent Runs](/agents/runs). If nothing needs him, say so in one line. Pass the same bullets to ops_save_brief as highlights, with label and link.

## Team
One or two sentences: hours clocked, who is clocked in now, anything overdue by person if the snapshot shows it.

## Money
One or two sentences: invoices paid in the window, outstanding and overdue totals. Pence become pounds (12000 pence is £120.00).

Rules: never state a number, a client, a case or a post that the two tools did not return; if a figure is null, say it was not measured. No greeting, no sign-off, no emoji, no praise. Do not repeat the section headings' words as sentences. Finish with one internal sentence saying the brief was saved.`;

/**
 * Reads the last 24 hours and the open state, writes a brief of at most
 * ${OPS_BRIEF_MAX_WORDS} words, and saves it. Every tool is read-only except
 * the save, which writes our own `ops_briefs` row; nothing reaches a client.
 * The worker's `ops.brief` job runs it at 07:00 London per organisation and,
 * once the brief is saved, tells the owner.
 */
export function opsBrief(): AgentDefinition {
  return {
    key: OPS_BRIEF_KEY,
    name: "Ops Brief",
    description:
      "Every morning at 07:00, reads the last 24 hours and the open state and writes a short brief of what happened, " +
      "what needs the owner today, how the team is doing and where the money is.",
    trigger: { kind: "cron", schedule: OPS_BRIEF_CRON, timezone: "Europe/London" },
    systemPrompt: OPS_BRIEF_PROMPT,
    tools: [opsMetricsSnapshotTool, opsRecentActivity, opsSaveBrief],
    // Two reads, one save, and a turn to trim an over-long brief.
    maxTurns: 8,
  };
}
