import { z } from "zod";

export interface RawAttachment { name: string; contentType: string; contentBase64: string }
export interface StoredAttachment { name: string; contentType: string; size: number; url: string }

export type InboundProvider = "postmark" | "cloudflare" | "generic";

export interface NormalisedInbound {
  provider: InboundProvider;
  to: string[];
  from: string;
  fromName?: string | undefined;
  subject: string;
  text: string;
  html?: string | undefined;
  messageId: string;
  inReplyTo?: string | undefined;
  references: string[];
  attachments: RawAttachment[];
  rawHeaders: Record<string, string>;
}

/** What the queue carries: identical, except attachments are already on disk. */
export type InboundEmail = Omit<NormalisedInbound, "attachments"> & { attachments: StoredAttachment[] };

export const InboundEmailSchema = z.object({
  provider: z.enum(["postmark", "cloudflare", "generic"]),
  to: z.array(z.string()).min(1),
  from: z.string().min(3),
  fromName: z.string().optional(),
  subject: z.string(),
  text: z.string(),
  html: z.string().optional(),
  messageId: z.string().min(1),
  inReplyTo: z.string().optional(),
  references: z.array(z.string()),
  attachments: z.array(z.object({ name: z.string(), contentType: z.string(), size: z.number().int().nonnegative(), url: z.string() })),
  rawHeaders: z.record(z.string(), z.string()),
});

/** Message-IDs are compared as strings, so normalise them to `<...>` form once. */
export function angle(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

export function splitReferences(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/\s+/).map((v) => v.trim()).filter((v) => v.length > 0).map(angle);
}

function ensureRecipient(to: string[]): string[] {
  const cleaned = to.map((t) => t.trim().toLowerCase()).filter((t) => t.includes("@"));
  if (cleaned.length === 0) throw new Error("inbound email has no recipient address");
  return cleaned;
}

const PostmarkPayload = z.object({
  From: z.string(), FromName: z.string().optional(), Subject: z.string().default(""),
  To: z.string().optional(),
  ToFull: z.array(z.object({ Email: z.string() })).optional(),
  TextBody: z.string().default(""), HtmlBody: z.string().optional(),
  MessageID: z.string(),
  Headers: z.array(z.object({ Name: z.string(), Value: z.string() })).default([]),
  Attachments: z.array(z.object({ Name: z.string(), ContentType: z.string(), Content: z.string() })).default([]),
});

export function normalizePostmark(payload: unknown): NormalisedInbound {
  const p = PostmarkPayload.parse(payload);
  const headers = Object.fromEntries(p.Headers.map((h) => [h.Name.toLowerCase(), h.Value]));
  return {
    provider: "postmark",
    to: ensureRecipient(p.ToFull?.map((t) => t.Email) ?? (p.To ? p.To.split(",") : [])),
    from: p.From.trim().toLowerCase(),
    fromName: p.FromName,
    subject: p.Subject,
    text: p.TextBody,
    html: p.HtmlBody,
    messageId: angle(p.MessageID),
    inReplyTo: headers["in-reply-to"] ? angle(headers["in-reply-to"]) : undefined,
    references: splitReferences(headers["references"]),
    attachments: p.Attachments.map((a) => ({ name: a.Name, contentType: a.ContentType, contentBase64: a.Content })),
    rawHeaders: headers,
  };
}

const CloudflarePayload = z.object({
  to: z.union([z.string(), z.array(z.string())]),
  from: z.string(), fromName: z.string().optional(),
  subject: z.string().default(""), text: z.string().default(""), html: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
});

/** Shape posted by the Cloudflare Email Routing worker documented in DEPLOYMENT.md. */
export function normalizeCloudflare(payload: unknown): NormalisedInbound {
  const p = CloudflarePayload.parse(payload);
  const headers = Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const messageId = headers["message-id"];
  if (!messageId) throw new Error("cloudflare inbound payload has no Message-ID header");
  return {
    provider: "cloudflare",
    to: ensureRecipient(Array.isArray(p.to) ? p.to : [p.to]),
    from: p.from.trim().toLowerCase(),
    fromName: p.fromName,
    subject: p.subject,
    text: p.text,
    html: p.html,
    messageId: angle(messageId),
    inReplyTo: headers["in-reply-to"] ? angle(headers["in-reply-to"]) : undefined,
    references: splitReferences(headers["references"]),
    attachments: [],
    rawHeaders: headers,
  };
}

const GenericPayload = z.object({
  to: z.union([z.string(), z.array(z.string())]),
  from: z.string(), fromName: z.string().optional(),
  subject: z.string().default(""), text: z.string().default(""), html: z.string().optional(),
  messageId: z.string(), inReplyTo: z.string().optional(),
  references: z.array(z.string()).default([]),
  attachments: z.array(z.object({ name: z.string(), contentType: z.string(), contentBase64: z.string() })).default([]),
  headers: z.record(z.string(), z.string()).default({}),
});

export function normalizeGeneric(payload: unknown): NormalisedInbound {
  const p = GenericPayload.parse(payload);
  return {
    provider: "generic",
    to: ensureRecipient(Array.isArray(p.to) ? p.to : [p.to]),
    from: p.from.trim().toLowerCase(),
    fromName: p.fromName,
    subject: p.subject,
    text: p.text,
    html: p.html,
    messageId: angle(p.messageId),
    inReplyTo: p.inReplyTo ? angle(p.inReplyTo) : undefined,
    references: p.references.map(angle),
    attachments: p.attachments,
    rawHeaders: p.headers,
  };
}

export function normalizeInbound(provider: InboundProvider, payload: unknown): NormalisedInbound {
  if (provider === "postmark") return normalizePostmark(payload);
  if (provider === "cloudflare") return normalizeCloudflare(payload);
  return normalizeGeneric(payload);
}
