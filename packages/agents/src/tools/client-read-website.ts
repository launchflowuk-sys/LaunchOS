import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { defineTool } from "../kernel/types.js";

/**
 * Reads a client's own website, so a brief can be written from what the
 * business actually says about itself.
 *
 * **The model never chooses the URL.** It passes a `clientId`, and the address
 * is looked up from `clients.website_url` and that client's sites. That is the
 * whole security design: a tool that fetched a URL an LLM handed it would be a
 * server-side request forgery with a language model holding the steering
 * wheel — reachable at `http://169.254.169.254/`, at `http://localhost:5432`,
 * at anything else inside the network. Taking the address from our own rows
 * means the worst case is fetching a client's site, which is a thing we
 * already do every day with the uptime probe.
 *
 * Two further limits, because a row is not automatically safe either: only
 * `http`/`https` schemes, and the response is capped and truncated. A brief
 * needs the first screenful of a homepage, not a 4MB single-page app.
 */

/** Enough to see what a business does; far short of anything worth paying for. */
const MAX_BYTES = 400_000;
const MAX_CHARS = 8_000;
const TIMEOUT_MS = 12_000;

/** Tags whose contents are markup or code rather than anything a reader sees. */
const STRIP_BLOCKS = /<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi;

export function htmlToText(html: string): string {
  return html
    .replace(STRIP_BLOCKS, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/** Only ever the addresses on the client's own record, and only over http(s). */
function usable(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export const clientReadWebsite = defineTool({
  name: "client_read_website",
  description:
    "Fetch the readable text of this client's own website, to write a brief from what the business says about " +
    "itself. You cannot choose the address — it comes from the client's record. Returns the page text, truncated.",
  input: z.object({
    clientId: z.string().uuid(),
    /** A path on the same site, for an About or Services page found in the homepage text. */
    path: z.string().max(200).optional(),
  }),
  risk: "safe",
  execute: async ({ clientId, path }, ctx) => {
    const [client] = await ctx.db
      .select({ websiteUrl: schema.clients.websiteUrl })
      .from(schema.clients)
      .where(and(
        eq(schema.clients.id, clientId),
        eq(schema.clients.organisationId, ctx.organisationId),
        isNull(schema.clients.deletedAt),
      ));
    if (!client) return { read: false as const, reason: "No such client in this organisation." };

    const [site] = await ctx.db
      .select({ primaryUrl: schema.sites.primaryUrl })
      .from(schema.sites)
      .where(and(
        eq(schema.sites.clientId, clientId),
        eq(schema.sites.organisationId, ctx.organisationId),
        isNull(schema.sites.deletedAt),
      ));

    const base = usable(client.websiteUrl) ?? usable(site?.primaryUrl);
    if (!base) return { read: false as const, reason: "This client has no website address on record." };

    // A path is resolved *against* the client's own origin, so even a path the
    // model invented cannot reach another host.
    let target = base;
    if (path) {
      try {
        target = new URL(path, base).toString();
      } catch {
        return { read: false as const, reason: "That path could not be read." };
      }
    }

    let response: Response;
    try {
      response = await fetch(target, {
        redirect: "follow",
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": "LaunchOS/1.0 (+https://launchflow.co.uk)" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      return { read: false as const, url: target, reason: `The site could not be reached: ${error instanceof Error ? error.message : "unknown error"}` };
    }
    if (!response.ok) return { read: false as const, url: target, reason: `The site answered ${response.status}.` };

    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("text/plain")) {
      return { read: false as const, url: target, reason: `That address returned ${type || "an unknown type"}, not a web page.` };
    }

    const raw = await response.text();
    const text = htmlToText(raw.slice(0, MAX_BYTES));
    return {
      read: true as const,
      url: target,
      truncated: text.length > MAX_CHARS,
      text: text.slice(0, MAX_CHARS),
    };
  },
});
