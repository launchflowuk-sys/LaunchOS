/**
 * The one HTML shell every outbound LaunchFlow email wears.
 *
 * Written for the three clients that matter — Outlook (Word's rendering
 * engine), Gmail (strips `<style>` in a forwarded message and everywhere on
 * some mobile clients) and Apple Mail — which is why it is nested tables and
 * inline styles rather than the flexbox any browser would render happily. The
 * rules that follow from that, and that are easy to undo by accident:
 *
 * - **Every style is inline.** There is no `<style>` block to strip, and no
 *   class does any work. A media query would be the one exception worth having
 *   and we do not need it: the layout is fluid to begin with (see below).
 * - **`width="100%"` with `max-width: 600px`,** never a fixed 600. Outlook
 *   ignores `max-width` and takes the attribute, so it gets its 600px table;
 *   every other client honours the max-width and shrinks to a 375px phone
 *   without a horizontal scroll. Images carry `max-width: 100%; height: auto`
 *   for the same reason.
 * - **Colours are hex.** `oklch()` is what `globals.css` speaks and no mail
 *   client understands it, so the brand values are written out here as the
 *   sRGB they resolve to. The two that must match the product are
 *   `--primary` (`#0A71B1`) and the logo navy; `BRAND` below is the whole set.
 * - **Nothing is fetched.** One image — the logo, from an absolute URL on our
 *   own app — and no web font: `Segoe UI`/`Helvetica` is what the recipient
 *   already has, and a mail client that blocks images must still show a
 *   complete message. Hence the `alt` text on the logo.
 *
 * Everything that reaches the page from a person, a client record or a model
 * goes through `escapeHtml`. A support reply is a client's own words coming
 * back out of `messages.body`, an ad report summary is LLM output, and an
 * invoice carries a client name somebody typed — none of them may put a tag in
 * this document. `bodyHtml` is the deliberate exception and is documented as
 * trusted-caller-only.
 */

/** The brand, as hex, because mail clients do not speak `oklch()`. */
export const BRAND = {
  /** The page behind the card — DESIGN.md's cool off-white, one step cooler. */
  ground: "#F4F7FA",
  card: "#FFFFFF",
  /** The logo's "Flow" navy: headings and the strongest ink. */
  navy: "#101020",
  /** `--primary`, `oklch(0.53 0.13 245)`. White on it is 5.23:1. */
  blue: "#0A71B1",
  /** The swoosh cyan. An accent bar and a rule — never text, never a fill behind text. */
  cyan: "#10C0E0",
  /** Body ink: 11.3:1 on white. */
  ink: "#2C3440",
  /** Footer and meta: 4.9:1 on the ground, so it is still readable, not decorative. */
  muted: "#5B6672",
  hairline: "#DDE4EC",
} as const;

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

/** Where a reply goes when the message itself carries no better address. */
export const DEFAULT_SUPPORT_ADDRESS = "hello@launchflow.co.uk";

export interface BrandedEmailCta {
  label: string;
  /** Absolute `http(s)` URL. Anything else is dropped rather than rendered. */
  url: string;
}

export interface BrandedEmailInput {
  /** The one line a phone shows next to the subject. Escaped, then hidden. */
  preheader: string;
  /** The `<h1>` of the message — a case subject, an invoice number. Escaped. */
  heading: string;
  /**
   * Trusted HTML for the body, for the rare caller that composes its own markup
   * (a table of figures, say). **Never pass user, client or model text through
   * this** — that is what `paragraphs` is for. Ignored when `paragraphs` is set.
   */
  bodyHtml?: string;
  /**
   * The body as plain text. Each entry is a paragraph; a newline inside one
   * becomes a `<br>`. Escaped in full, so Markdown in it stays literal text
   * rather than becoming markup — a client's `**` reads as asterisks and a
   * model's stray `<div>` reads as a `<div>`.
   */
  paragraphs?: readonly string[];
  cta?: BrandedEmailCta;
  /** A quieter line under the body: "reply to this email", "the approval is spent". */
  footerNote?: string;
  /** Absolute URL of the wordmark PNG. */
  logoUrl: string;
  /** Absolute URL of the app, linked in the footer. */
  appUrl: string;
  /** The address in the footer. Defaults to `DEFAULT_SUPPORT_ADDRESS`. */
  supportEmail?: string;
  /**
   * `"client"` is the full card. `"internal"` is the compact variant owner
   * notifications use: same shell, narrower, no marketing footer — it is a
   * message to ourselves, and dressing it up as a client email would make the
   * two hard to tell apart in one inbox.
   */
  variant?: "client" | "internal";
}

export interface RenderedEmail {
  html: string;
  text: string;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * The whole defence against a client's words, a model's output or a typed
 * client name turning into markup in an email nobody can retract.
 *
 * `&` first is not optional — done last it would double-escape everything the
 * earlier replacements produced. A single pass over the character class avoids
 * the ordering question entirely.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char]!);
}

/** An absolute `http(s)` URL, or undefined. Keeps `javascript:` out of an `href`. */
function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Escaped text with newlines as `<br>`, so a typed paragraph keeps its shape. */
function asHtmlParagraph(text: string, fontSize: string): string {
  const body = escapeHtml(text).replace(/\r?\n/g, "<br />");
  return `<p style="margin:0 0 14px;font-size:${fontSize};line-height:1.6;color:${BRAND.ink};">${body}</p>`;
}

/**
 * Splits a message body into paragraphs on blank lines, dropping anything that
 * is nothing but `skipUrl`.
 *
 * The second half is what stops a branded email showing the same link twice:
 * the courtesy notice's stored body ends with the portal URL on its own line,
 * because that body is also the record of what the client was told, and the
 * button beside it now carries the same address. The plain-text alternative
 * still ends with the URL — it is built from the CTA, so nothing is lost.
 */
export function paragraphsFromBody(body: string, skipUrl?: string): string[] {
  return body
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && (!skipUrl || part !== skipUrl));
}

function ctaHtml(cta: BrandedEmailCta, url: string): string {
  // `border-radius` on the anchor rather than the cell: Outlook squares the
  // corners either way, and every other client rounds the thing that is
  // actually painted. The 44px minimum height is the phone tap target.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px;">
              <tr>
                <td align="center" bgcolor="${BRAND.blue}" style="border-radius:8px;">
                  <a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 26px;font-family:${FONT_STACK};font-size:15px;font-weight:600;line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:8px;">${escapeHtml(cta.label)}</a>
                </td>
              </tr>
            </table>`;
}

/**
 * Renders one branded message.
 *
 * Returns both halves deliberately: the plain-text alternative is not a
 * courtesy, it is what a text-only client, a screen reader in plain mode and a
 * spam filter all read, and a message sent as HTML alone scores worse and
 * degrades worse. `OutboundEmail` carries both, the SMTP adapter sends both as
 * a multipart alternative, and the mock records both.
 */
export function renderBrandedEmail(input: BrandedEmailInput): RenderedEmail {
  const internal = input.variant === "internal";
  const maxWidth = internal ? 520 : 600;
  const bodySize = internal ? "14px" : "15px";
  const supportEmail = input.supportEmail ?? DEFAULT_SUPPORT_ADDRESS;
  const appUrl = safeUrl(input.appUrl);
  const logoUrl = safeUrl(input.logoUrl);
  const cta = input.cta ? safeUrl(input.cta.url) : undefined;

  const paragraphs = input.paragraphs?.filter((p) => p.trim().length > 0) ?? [];
  const bodyHtml =
    paragraphs.length > 0
      ? paragraphs.map((p) => asHtmlParagraph(p, bodySize)).join("\n            ")
      : (input.bodyHtml ?? "");

  const logoBlock = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" width="132" alt="LaunchFlow" style="display:block;width:132px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;" />`
    : `<span style="font-size:17px;font-weight:700;color:${BRAND.navy};">LaunchFlow</span>`;

  const footerLinks = [
    "Powered by LaunchFlow",
    `<a href="mailto:${escapeHtml(supportEmail)}" style="color:${BRAND.muted};text-decoration:underline;">${escapeHtml(supportEmail)}</a>`,
    appUrl
      ? `<a href="${escapeHtml(appUrl)}" style="color:${BRAND.muted};text-decoration:underline;">${escapeHtml(appUrl.replace(/\/$/, ""))}</a>`
      : null,
  ].filter(Boolean) as string[];

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${escapeHtml(input.heading)}</title>
  </head>
  <body style="margin:0;padding:0;width:100%;background-color:${BRAND.ground};">
    <!-- The preheader: the line a phone shows beside the subject. Hidden in the
         body, then padded so the client does not pull the first paragraph in
         after it. -->
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;height:0;width:0;">${escapeHtml(input.preheader)}&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;&#8203;&#847;</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BRAND.ground};">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${maxWidth}px;width:100%;">
            <tr>
              <td style="padding:0 0 16px;">
                ${logoBlock}
              </td>
            </tr>
            <tr>
              <td style="background-color:${BRAND.card};border:1px solid ${BRAND.hairline};border-radius:12px;overflow:hidden;">
                <!-- The cyan bar off the swoosh: the one decorative stroke in
                     the whole layout, and the thing that makes a LaunchFlow
                     email recognisable at a glance in a crowded inbox. -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td height="4" bgcolor="${BRAND.cyan}" style="height:4px;line-height:4px;font-size:0;">&nbsp;</td>
                  </tr>
                  <tr>
                    <td style="padding:${internal ? "22px 22px 24px" : "26px 28px 28px"};font-family:${FONT_STACK};">
                      <h1 style="margin:0 0 14px;font-size:${internal ? "17px" : "20px"};line-height:1.3;font-weight:600;letter-spacing:-0.01em;color:${BRAND.navy};">${escapeHtml(input.heading)}</h1>
                      ${bodyHtml}
                      ${input.cta && cta ? ctaHtml(input.cta, cta) : ""}
                      ${input.footerNote ? `<p style="margin:18px 0 0;padding-top:16px;border-top:1px solid ${BRAND.hairline};font-size:13px;line-height:1.6;color:${BRAND.muted};">${escapeHtml(input.footerNote)}</p>` : ""}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 8px 0;font-family:${FONT_STACK};font-size:12px;line-height:1.7;color:${BRAND.muted};">
                ${footerLinks.join(" &middot; ")}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

  const textParts: string[] = [input.heading, ""];
  if (paragraphs.length > 0) textParts.push(paragraphs.join("\n\n"), "");
  if (input.cta && cta) textParts.push(`${input.cta.label}: ${cta}`, "");
  if (input.footerNote) textParts.push(input.footerNote, "");
  textParts.push(
    "--",
    `Powered by LaunchFlow${appUrl ? ` · ${appUrl.replace(/\/$/, "")}` : ""}`,
    supportEmail,
  );

  return { html, text: textParts.join("\n").trimEnd() };
}
