import type { CostBusiness } from "./register.js";

/**
 * Reading Anthropic's cost export.
 *
 * Admin keys — the credential the Usage and Cost API needs — are only issued
 * to Team and Enterprise organisations. On an individual account the API is
 * simply not available, so the Console's CSV export is the only way to get at
 * what was actually billed. This parses it.
 *
 * That is a smaller compromise than it sounds. Reconciliation is a monthly
 * job, and a monthly export is barely worse than a monthly API call.
 *
 * The file's own columns, as exported:
 *
 *   usage_date_utc, model, workspace, api_key, usage_type, context_window,
 *   token_type, cost_usd, list_price_usd, cost_type, inference_geo, speed,
 *   api_key_id, api_key_status
 *
 * **`api_key` is the attribution.** Each business has its own key — `Agent
 * Zero New`, `LaunchFlow OS Workspace`, `NexusEDU` — so spend splits by
 * business with no tagging by hand. That was not designed for; it is a
 * property of how the keys were already set up, and it is the reason this
 * import is worth having rather than a single monthly total.
 *
 * Amounts are **USD cents**. The file states dollars to two decimals; they are
 * multiplied by 100 and rounded once, here, rather than carried as floats.
 */

/** One row of the export, after parsing. */
export interface AnthropicCostRow {
  /** `2026-09-13`, as exported — UTC, no time component. */
  day: string;
  model: string;
  /** The API key's name, which is how a business is identified. */
  apiKey: string;
  tokenType: string;
  /** USD cents. */
  costCents: number;
}

export interface AnthropicImportSummary {
  rows: number;
  /** Rows skipped because they carried no cost, or could not be read. */
  skipped: number;
  firstDay: string | null;
  lastDay: string | null;
  totalCents: number;
  /** USD cents by API key name — the per-business split. */
  byApiKey: Record<string, number>;
  byModel: Record<string, number>;
}

export interface AnthropicImportResult {
  rows: AnthropicCostRow[];
  summary: AnthropicImportSummary;
}

/**
 * How an API key's name maps onto a business.
 *
 * Matched on a lower-cased substring rather than equality, because these are
 * names a person typed into a console and will type differently next time.
 * Anything unrecognised is left for a human to assign instead of being guessed
 * into `launchflow` — a mis-attributed cost is worse than an unattributed one,
 * because nobody goes looking for it.
 */
const KEY_TO_BUSINESS: readonly (readonly [match: string, business: CostBusiness])[] = [
  ["launchflow", "launchflow"],
  ["launch flow", "launchflow"],
  ["cabio", "cabio"],
  ["cabline", "grays_cabline"],
  ["agent zero", "agent_zero"],
  ["nexus", "nexus_education"],
  ["compliance", "strix"],
  ["strix", "strix"],
  ["masjid", "grays_park_masjid"],
  ["pc doctor", "mobile_pc_doctor"],
];

/** The business an API key belongs to, or null when nothing matches. */
export function businessForApiKey(apiKey: string): CostBusiness | null {
  const name = apiKey.trim().toLowerCase();
  if (name.length === 0) return null;
  for (const [match, business] of KEY_TO_BUSINESS) {
    if (name.includes(match)) return business;
  }
  return null;
}

/** Splits a CSV line, honouring double-quoted fields. Model names contain no commas today; this does not rely on that. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

/** USD dollars as written in the file → cents, rounded once. */
function dollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/**
 * Parses the export.
 *
 * Tolerant on purpose: a header it does not recognise, a blank trailing line,
 * a row with a malformed amount — each is skipped and counted rather than
 * thrown. A person is pasting a file they downloaded from a console; refusing
 * the whole month because line 94 is odd is not useful behaviour.
 *
 * Rows costing nothing are skipped. The export is dense with `0.00` lines —
 * a token type that happened to be free that day — and keeping them makes the
 * row count look like activity that did not cost anything.
 */
export function parseAnthropicCostCsv(text: string): AnthropicImportResult {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const rows: AnthropicCostRow[] = [];
  let skipped = 0;

  if (lines.length === 0) {
    return { rows, summary: emptySummary() };
  }

  const header = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const at = (name: string) => header.indexOf(name);
  const iDay = at("usage_date_utc");
  const iModel = at("model");
  const iKey = at("api_key");
  const iToken = at("token_type");
  const iCost = at("cost_usd");

  // Without a date and an amount there is nothing to reconcile against.
  if (iDay < 0 || iCost < 0) {
    return { rows, summary: { ...emptySummary(), skipped: lines.length - 1 } };
  }

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line);
    const day = (cells[iDay] ?? "").trim();
    const cents = dollarsToCents(cells[iCost] ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || cents === null) {
      skipped += 1;
      continue;
    }
    if (cents === 0) {
      skipped += 1;
      continue;
    }
    rows.push({
      day,
      model: (iModel >= 0 ? cells[iModel] ?? "" : "").trim(),
      apiKey: (iKey >= 0 ? cells[iKey] ?? "" : "").trim(),
      tokenType: (iToken >= 0 ? cells[iToken] ?? "" : "").trim(),
      costCents: cents,
    });
  }

  return { rows, summary: summarise(rows, skipped) };
}

function emptySummary(): AnthropicImportSummary {
  return { rows: 0, skipped: 0, firstDay: null, lastDay: null, totalCents: 0, byApiKey: {}, byModel: {} };
}

function summarise(rows: readonly AnthropicCostRow[], skipped: number): AnthropicImportSummary {
  const byApiKey: Record<string, number> = {};
  const byModel: Record<string, number> = {};
  let totalCents = 0;
  let firstDay: string | null = null;
  let lastDay: string | null = null;

  for (const row of rows) {
    totalCents += row.costCents;
    byApiKey[row.apiKey] = (byApiKey[row.apiKey] ?? 0) + row.costCents;
    byModel[row.model] = (byModel[row.model] ?? 0) + row.costCents;
    if (firstDay === null || row.day < firstDay) firstDay = row.day;
    if (lastDay === null || row.day > lastDay) lastDay = row.day;
  }

  return { rows: rows.length, skipped, firstDay, lastDay, totalCents, byApiKey, byModel };
}

/** USD cents per business, for the rows whose key could be matched. Unmatched keys are returned separately. */
export function centsByBusiness(summary: AnthropicImportSummary): {
  matched: Partial<Record<CostBusiness, number>>;
  unmatched: Record<string, number>;
} {
  const matched: Partial<Record<CostBusiness, number>> = {};
  const unmatched: Record<string, number> = {};
  for (const [apiKey, cents] of Object.entries(summary.byApiKey)) {
    const business = businessForApiKey(apiKey);
    if (business) matched[business] = (matched[business] ?? 0) + cents;
    else unmatched[apiKey] = (unmatched[apiKey] ?? 0) + cents;
  }
  return { matched, unmatched };
}
