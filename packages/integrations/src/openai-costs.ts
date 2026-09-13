/**
 * What OpenAI actually billed, from the organisation Costs API.
 *
 * Needs an **admin key** (`sk-admin-…`), which is a different credential from
 * the one that makes calls. Without it this returns null and the
 * reconciliation reports "not reconciled" — never a zero gap, because a
 * provider nobody checked must look unchecked.
 *
 * Anthropic has no equivalent available on an individual account: admin keys
 * there are Team and Enterprise only, so that side is the Console's CSV export
 * read by `parseAnthropicCostCsv`. Same job, different door.
 *
 * A leaf: it returns cents and says nothing about what they mean.
 */

export interface OpenAiCostWindow {
  /** Total billed in the window, **USD cents**. */
  cents: number;
  /** What the API actually covered, which may be shorter than asked for. */
  from: Date;
  to: Date;
}

interface CostsResponse {
  data?: { results?: { amount?: { value?: number; currency?: string } }[] }[];
}

export interface OpenAiCostsOptions {
  adminKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Billed cost for a calendar month.
 *
 * Returns null for a missing key, a refusal or an unreadable reply — every one
 * of which means "we could not ask", and all of which the caller must treat
 * the same way. The distinction the caller needs is in the log, not the return
 * value.
 *
 * The API buckets by day and reports each bucket's amount in dollars; they are
 * summed and converted to cents once, at the end.
 */
export async function openAiMonthlyCost(
  month: Date,
  options: OpenAiCostsOptions,
): Promise<OpenAiCostWindow | null> {
  if (!options.adminKey?.trim()) return null;

  const from = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const to = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
  const base = options.baseUrl ?? "https://api.openai.com/v1";
  const doFetch = options.fetchImpl ?? fetch;

  const url = new URL(`${base}/organization/costs`);
  url.searchParams.set("start_time", String(Math.floor(from.getTime() / 1000)));
  url.searchParams.set("end_time", String(Math.floor(to.getTime() / 1000)));
  url.searchParams.set("limit", "31");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const response = await doFetch(url, {
      headers: { authorization: `Bearer ${options.adminKey}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as CostsResponse;

    let dollars = 0;
    for (const bucket of payload.data ?? []) {
      for (const result of bucket.results ?? []) {
        const value = Number(result.amount?.value ?? 0);
        if (Number.isFinite(value)) dollars += value;
      }
    }
    // Rounded once, at the end: rounding each daily bucket would drift by a
    // cent a day over a month.
    return { cents: Math.round(dollars * 100), from, to };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
