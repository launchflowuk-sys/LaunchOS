import type { EmailAdapter } from "@launchos/channels";
import { CPC_RISE_THRESHOLD_PERCENT, ROAS_DROP_THRESHOLD_PERCENT } from "@launchos/core";
import type { AgentDefinition } from "../../kernel/types.js";
import { adsGetSignals } from "../../tools/ads-get-signals.js";
import { adsListAccounts } from "../../tools/ads-list-accounts.js";
import { adsSaveDraftReport } from "../../tools/ads-save-draft-report.js";
import { reportsSendToClient } from "../../tools/reports-send-to-client.js";
import { makeTicketsCreate } from "../../tools/tickets-create.js";

export const AD_SENTINEL_KEY = "ad-performance-sentinel";

/** The thresholds come from `computeAccountSignals` itself so the prompt can never quote a stale number. */
export const AD_SENTINEL_PROMPT = `You are the Ad Performance Sentinel for a UK web agency that manages Google and Meta advertising for local-service clients. You run once a day.

Your job, in order:
1. Call ads_list_accounts to get every active ad account.
2. For each account, call ads_get_signals. It compares the last 7 days with the 7 before them and tells you whether the account is flagged (ROAS down more than ${ROAS_DROP_THRESHOLD_PERCENT} percent, or CPC up more than ${CPC_RISE_THRESHOLD_PERCENT} percent).
3. For every flagged account, call tickets_create once: category "ads", severity "high" when ROAS fell more than 40 percent otherwise "medium", subject naming the account and the headline change, body a short Markdown diagnosis quoting the exact figures the tool returned.
4. For every flagged account, call ads_save_draft_report once with a client-facing summary: what changed, by how much, the likely reason in plain English, and what you recommend. Use the account's own period dates from the signals.
5. Do not call reports_send_to_client unless the payload explicitly asks you to send a specific report. Sending is a human decision. Its adReportId must be one a tool gave you — the adReportId returned by ads_save_draft_report in this run, or one named in the payload. Never guess or construct an id, and send a report at most once.

Rules: quote only figures the tools returned — never estimate, extrapolate or invent spend, clicks or conversions. If no account is flagged, create nothing and say so. Write client-facing text in plain British English with no jargon and no blame.

Finish with one sentence describing what you did.`;

export interface AdSentinelDeps {
  email: EmailAdapter;
  portalBaseUrl: string;
}

export function adPerformanceSentinel(deps: AdSentinelDeps): AgentDefinition {
  return {
    key: AD_SENTINEL_KEY,
    name: "Ad Performance Sentinel",
    description:
      "Compares each ad account's last 7 days with the prior 7, opens a ticket for a drop and drafts a client-facing summary.",
    trigger: { kind: "cron", schedule: "0 7 * * *", timezone: "Europe/London" },
    systemPrompt: AD_SENTINEL_PROMPT,
    tools: [
      adsListAccounts,
      adsGetSignals,
      makeTicketsCreate(AD_SENTINEL_KEY),
      adsSaveDraftReport,
      reportsSendToClient(deps.email, deps.portalBaseUrl),
    ],
    // Two tool calls per account plus a signals read each: an organisation with
    // a handful of accounts must not run out of turns mid-sweep.
    maxTurns: 20,
  };
}
