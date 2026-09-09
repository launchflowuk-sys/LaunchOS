import { renderBrandedEmail, type EmailAdapter } from "@launchos/channels";
import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq } from "drizzle-orm";
import { brandEmailContext, supportEmailFor } from "../config.js";
import { ukLongDate } from "../tasks/dates.js";

/**
 * Telling the client their domain is running out.
 *
 * **Only when they have to act.** A domain set to auto-renew is ours to watch,
 * not theirs to worry about, and mailing a client "your domain expires in 30
 * days" about one we renew for them produces a phone call, not a renewal. So
 * this goes out only when `auto_renew` is off — the case where nobody but the
 * client can stop the site going dark — or when it has already lapsed.
 *
 * **Not through the approvals gate**, and that is a deliberate reading rather
 * than an oversight. The gate exists so an *agent* cannot act outward on its
 * own judgement. This is a sweep sending a factual notice about the client's
 * own service on a fixed schedule, which is the same class as the meeting
 * reminders and the invoice mail that already send directly. Queuing an
 * approval card for each one would mean a domain lapses while a card waits.
 *
 * Two thresholds, not five. Shoji gets 60/30/14/7/1 because he is managing it;
 * the client gets 30 and 7, and once it has gone. A client who receives five
 * emails about one domain reads none of them.
 */

/** Days at which the client is told. A subset of the owner's thresholds, on purpose. */
export const CLIENT_EXPIRY_THRESHOLDS = [30, 7] as const;

export interface DomainExpiryEmailInput {
  clientId: string;
  domainName: string;
  expiresAt: Date;
  days: number;
  registrar: string | null;
}

export interface DomainExpiryEmailDeps {
  email?: EmailAdapter | undefined;
}

export interface DomainExpiryEmailResult {
  sent: boolean;
  /** Why not, for the sweep's log. Null when it went. */
  reason: string | null;
}

/** Whether this crossing is one the client hears about at all. */
export function clientShouldHear(days: number, autoRenew: boolean): boolean {
  if (days < 0) return true;
  if (autoRenew) return false;
  return (CLIENT_EXPIRY_THRESHOLDS as readonly number[]).includes(days);
}

/**
 * Never throws. A registrar warning that failed to send must not take the
 * sweep down with it — the owner's notification has already gone, and that is
 * the one that guarantees somebody knows.
 */
export async function sendDomainExpiryEmail(
  db: Db,
  organisationId: string,
  input: DomainExpiryEmailInput,
  deps: DomainExpiryEmailDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<DomainExpiryEmailResult> {
  if (!deps.email) return { sent: false, reason: "no email provider configured" };

  const [client] = await db
    .select({ name: schema.clients.name, email: schema.clients.email })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, input.clientId), eq(schema.clients.organisationId, organisationId)));
  if (!client?.email) return { sent: false, reason: "the client has no email address on record" };

  const brand = brandEmailContext(env);
  const gone = input.days < 0;
  const heading = gone
    ? `${input.domainName} has expired`
    : `${input.domainName} expires in ${input.days} day${input.days === 1 ? "" : "s"}`;

  try {
    const { text, html } = renderBrandedEmail({
      variant: "client",
      preheader: gone
        ? "Your domain has lapsed and needs renewing now."
        : "Your domain needs renewing to keep your website and email working.",
      heading,
      paragraphs: [
        gone
          ? `${input.domainName} expired on ${ukLongDate(input.expiresAt)}. While it is lapsed your website and any email on that domain will stop working, and after a grace period the name can be bought by somebody else.`
          : `${input.domainName} is due for renewal on ${ukLongDate(input.expiresAt)}. If it is not renewed, your website and any email on that domain stop working on that date.`,
        input.registrar
          ? `It is registered with ${input.registrar}, and renewing it is done from your account there.`
          : "Renewing it is done from the account it is registered with.",
        "If you would rather we handled the renewal for you, reply to this email and we will sort it out.",
      ],
      cta: { label: "Talk to us about it", url: `${brand.appUrl}/portal/support/new` },
      footerNote: "Sent because we look after this domain for you. We will tell you again if it gets closer.",
      logoUrl: brand.logoUrl,
      appUrl: brand.appUrl,
      supportEmail: brand.supportEmail,
    });

    await deps.email.send({
      to: client.email,
      from: env["MAIL_FROM"] ?? supportEmailFor("support", env),
      subject: heading,
      text,
      html,
    });
  } catch (error) {
    return { sent: false, reason: error instanceof Error ? error.message : "the notice could not be sent" };
  }

  return { sent: true, reason: null };
}
