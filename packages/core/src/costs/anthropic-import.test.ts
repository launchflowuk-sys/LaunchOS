import { describe, expect, it } from "vitest";
import { businessForApiKey, centsByBusiness, parseAnthropicCostCsv } from "./anthropic-import.js";

const HEADER =
  "usage_date_utc,model,workspace,api_key,usage_type,context_window,token_type,cost_usd,list_price_usd,cost_type,inference_geo,speed,api_key_id,api_key_status";

const row = (day: string, model: string, key: string, tokenType: string, usd: string) =>
  `${day},${model},Default,${key},message,≤ 200k,${tokenType},${usd},${usd},token,global,,apikey_x,active`;

/** A trimmed copy of the real export, including the awkward parts. */
const SAMPLE = [
  HEADER,
  row("2026-08-15", "Claude Haiku 4.5", "Agent Zero New", "input_no_cache", "0.19"),
  row("2026-08-15", "Claude Haiku 4.5", "Agent Zero New", "output", "0.03"),
  row("2026-09-09", "Claude Opus 5", "LaunchFlow OS Workspace", "input_no_cache", "1.67"),
  row("2026-09-09", "Claude Opus 5", "LaunchFlow OS Workspace", "output", "0.99"),
  row("2026-08-29", "Claude Sonnet 5", "NexusEDU", "output", "0.01"),
  row("2026-08-23", "Claude Opus 5", "Compliance Data", "input_no_cache", "0.06"),
  // A free line, which the real export is full of.
  row("2026-08-17", "Claude Opus 5", "JARVIS", "output", "0.00"),
  "",
].join("\n");

describe("parseAnthropicCostCsv", () => {
  it("reads the real export's columns and totals it in cents", () => {
    const { rows, summary } = parseAnthropicCostCsv(SAMPLE);

    expect(rows).toHaveLength(6);
    // 0.19 + 0.03 + 1.67 + 0.99 + 0.01 + 0.06 = 2.95
    expect(summary.totalCents).toBe(295);
    expect(summary.firstDay).toBe("2026-08-15");
    expect(summary.lastDay).toBe("2026-09-09");
  });

  it("skips rows that cost nothing rather than counting them as activity", () => {
    const { summary } = parseAnthropicCostCsv(SAMPLE);
    expect(summary.skipped).toBe(1);
    expect(Object.keys(summary.byApiKey)).not.toContain("JARVIS");
  });

  it("splits spend by API key, which is how a business is identified", () => {
    const { summary } = parseAnthropicCostCsv(SAMPLE);
    expect(summary.byApiKey).toEqual({
      "Agent Zero New": 22,
      "LaunchFlow OS Workspace": 266,
      NexusEDU: 1,
      "Compliance Data": 6,
    });
  });

  it("splits by model too", () => {
    const { summary } = parseAnthropicCostCsv(SAMPLE);
    expect(summary.byModel["Claude Opus 5"]).toBe(272);
    expect(summary.byModel["Claude Haiku 4.5"]).toBe(22);
  });

  it("survives a file with nothing in it", () => {
    expect(parseAnthropicCostCsv("").summary.rows).toBe(0);
    expect(parseAnthropicCostCsv("   \n  ").summary.rows).toBe(0);
  });

  it("refuses a file without the columns it needs, rather than importing nonsense", () => {
    const { rows, summary } = parseAnthropicCostCsv("a,b,c\n1,2,3");
    expect(rows).toHaveLength(0);
    expect(summary.skipped).toBe(1);
  });

  it("skips a malformed row and keeps the rest of the month", () => {
    const { rows, summary } = parseAnthropicCostCsv(
      [HEADER, row("not-a-date", "m", "k", "t", "1.00"), row("2026-09-01", "m", "k", "t", "banana"), row("2026-09-02", "m", "k", "t", "2.50")].join("\n"),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.costCents).toBe(250);
    expect(summary.skipped).toBe(2);
  });

  it("handles a quoted field containing a comma", () => {
    const line = `2026-09-01,"Claude Opus 5, preview",Default,"Key, One",message,≤ 200k,output,1.00,1.00,token,global,,apikey_x,active`;
    const { rows } = parseAnthropicCostCsv([HEADER, line].join("\n"));
    expect(rows[0]!.model).toBe("Claude Opus 5, preview");
    expect(rows[0]!.apiKey).toBe("Key, One");
  });
});

describe("businessForApiKey", () => {
  it("matches the keys that exist today, however they are cased", () => {
    expect(businessForApiKey("LaunchFlow OS Workspace")).toBe("launchflow");
    expect(businessForApiKey("Agent Zero New")).toBe("agent_zero");
    expect(businessForApiKey("NexusEDU")).toBe("nexus_education");
    expect(businessForApiKey("Compliance Data")).toBe("strix");
    expect(businessForApiKey("cabio-prod")).toBe("cabio");
    expect(businessForApiKey("Grays CabLine")).toBe("grays_cabline");
  });

  it("leaves an unknown key for a human rather than guessing at LaunchFlow", () => {
    // A mis-attributed cost is worse than an unattributed one: nobody goes
    // looking for a number that already has an owner.
    expect(businessForApiKey("JARVIS")).toBeNull();
    expect(businessForApiKey("")).toBeNull();
  });
});

describe("centsByBusiness", () => {
  it("attributes what it can and hands back the rest by key name", () => {
    const { summary } = parseAnthropicCostCsv(
      [HEADER, row("2026-09-01", "m", "LaunchFlow OS Workspace", "output", "4.00"), row("2026-09-01", "m", "JARVIS", "output", "1.00")].join("\n"),
    );
    const { matched, unmatched } = centsByBusiness(summary);
    expect(matched.launchflow).toBe(400);
    expect(unmatched).toEqual({ JARVIS: 100 });
  });
});
