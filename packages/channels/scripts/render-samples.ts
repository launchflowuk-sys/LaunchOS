/**
 * Writes one sample of every branded email into `.superpowers/email-samples/`
 * so a person can open them in a browser and look, rather than reading the
 * markup or waiting for a real send.
 *
 *   pnpm --filter @launchos/channels samples
 *   # or: npx tsx packages/channels/scripts/render-samples.ts
 *
 * Each sample carries the same copy the real call site builds, so if a heading
 * or a button label changes in `core` and not here the two visibly disagree.
 * The output directory is gitignored: these are for looking at, not for review
 * as source.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBrandedEmail, type BrandedEmailInput } from "../src/email/template.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../../../.superpowers/email-samples");

const APP = "https://os.launchflow.co.uk";
const BRAND = {
  logoUrl: `${APP}/brand/launchflow-logo@600.png`,
  appUrl: APP,
  supportEmail: "hello@support.launchflow.co.uk",
};

/** The five shapes, one per outbound send site. */
const SAMPLES: Record<string, BrandedEmailInput> = {
  // packages/core/src/support/send-queued-message.ts — a staff or agent reply.
  reply: {
    ...BRAND,
    preheader: "Thanks for flagging this — the site is back up.",
    heading: "Site slow since this morning",
    paragraphs: [
      "Hello Jo,",
      "Thanks for flagging this. The box your site sits on had run out of memory overnight; we have moved you onto a bigger one and the response times are back where they should be.",
      "Nothing was lost and no action is needed at your end. **Bold** and <b>tags</b> stay as literal text, which is the point of the escaping.",
    ],
    cta: { label: "View your case", url: `${APP}/portal/support/8f2c1b40-0000-4000-8000-000000000001` },
    footerNote: "Reply to this email and your answer lands on the same case.",
    supportEmail: "grays-cabline@support.launchflow.co.uk",
  },

  // The courtesy notice queued by reply-to-conversation.ts, rendered by
  // send-queued-message.ts once it recognises `metadata.kind`.
  courtesy: {
    ...BRAND,
    preheader: "There is a reply waiting in your portal.",
    heading: "Card payments failing at checkout",
    paragraphs: ["LaunchFlow has replied to your support case. Sign in to the portal to read it."],
    cta: { label: "Read the reply", url: `${APP}/portal/support/8f2c1b40-0000-4000-8000-000000000002` },
    supportEmail: "grays-cabline@support.launchflow.co.uk",
  },

  // packages/core/src/billing/invoice-send.ts
  invoice: {
    ...BRAND,
    preheader: "£420.00, due 2026-09-30.",
    heading: "Invoice LF-2026-0018",
    paragraphs: [
      "Hello Grays CabLine,",
      "Invoice LF-2026-0018 for £420.00 is ready. It is due on 2026-09-30.",
    ],
    cta: { label: "View invoice", url: `${APP}/portal/invoices/8f2c1b40-0000-4000-8000-000000000003` },
    footerNote: "You can view, print and save this invoice as a PDF from the portal.",
  },

  // packages/core/src/ads/reports.ts
  report: {
    ...BRAND,
    preheader: "2026-08-01 to 2026-08-31.",
    heading: "Your Grays CabLine Search advertising summary",
    paragraphs: [
      "Hello Grays CabLine,",
      "Your advertising summary for 2026-08-01 to 2026-08-31 is ready in your portal.",
    ],
    cta: { label: "View the report", url: `${APP}/portal/reports` },
  },

  // apps/web/src/app/(admin)/settings/email/actions.ts — the OWNER_NOTIFY_EMAIL path.
  owner: {
    ...BRAND,
    variant: "internal",
    preheader: "Sent with the smtp adapter.",
    heading: "LaunchOS test email",
    paragraphs: [
      "Sent from LaunchOS Settings → Email at 2026-09-05T05:12:44.108Z using the smtp adapter.",
      "If this arrived, outbound email works and the branded layout renders in your client.",
    ],
    cta: { label: "Open LaunchOS", url: `${APP}/settings/email` },
  },
};

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  for (const [name, input] of Object.entries(SAMPLES)) {
    const { html, text } = renderBrandedEmail(input);
    await writeFile(resolve(OUT_DIR, `${name}.html`), html, "utf8");
    // The plain-text alternative beside it: it is half of every message and the
    // only half some recipients ever see, so it gets looked at too.
    await writeFile(resolve(OUT_DIR, `${name}.txt`), text, "utf8");
    process.stdout.write(`${name}.html\n`);
  }
  process.stdout.write(`\nwritten to ${OUT_DIR}\n`);
}

await main();
