import manifest from "./screenshots.json";
import type { WorkScreenshots, WorkStatus } from "./work";

/**
 * The things we run ourselves. The capture script screenshots these too,
 * keyed by slug, so a product with a public front page shows it.
 */
export type Product = {
  slug: string;
  name: string;
  /** Shown as the link text; `url` is where it goes. */
  domain: string;
  url: string;
  /** One line under the name. */
  tagline: string;
  /** A short paragraph: who it is for and what it does. */
  description: string;
  /** Two to four short facts. */
  facts: readonly string[];
  status: WorkStatus;
  screenshots: WorkScreenshots;
};

const SHOTS = manifest as Record<string, WorkScreenshots>;
function shots(slug: string): WorkScreenshots {
  return SHOTS[slug] ?? {};
}

export const PRODUCTS: readonly Product[] = [
  {
    slug: "cabio",
    name: "Cabio Master Booker",
    domain: "cabio.cab",
    url: "https://cabio.cab",
    tagline: "Multi-tenant taxi dispatch for UK operators.",
    description:
      "The dispatch platform our own taxi firm runs on, sold to other operators as a subscription. Each operator gets their own branded booking site and subdomain, a dispatch office, drivers on the app, and pricing by distance, time or fixed fare with night and zone surcharges. Built to compete with the incumbents on price and on speed.",
    facts: ["iOS and Android apps live", "Embeddable booking widget", "Card payments and subscription billing", "Runs Grays CabLine and Grays Taxis 247"],
    status: "live",
    screenshots: shots("cabio"),
  },
  {
    slug: "agent-zero",
    name: "Agent Zero",
    domain: "cabioagentzero.com",
    url: "https://cabioagentzero.com",
    tagline: "An AI phone agent that answers and books.",
    description:
      "Answers a business's inbound calls, holds a natural conversation, quotes a price and writes the booking into the back office. Calls arrive over Twilio and are routed to the right business by the number dialled, so many businesses share one platform. Operators choose whether the agent answers first or their phone rings first, by schedule.",
    facts: ["Claude for the conversation", "Twilio, Deepgram and ElevenLabs", "Pushes bookings into Cabio and other dispatch systems", "Operator app on both stores"],
    status: "live",
    screenshots: shots("agent-zero"),
  },
  {
    slug: "lima",
    name: "Lima",
    domain: "agentlima.com",
    url: "https://agentlima.com",
    tagline: "An inbox agent that drafts the reply.",
    description:
      "Connects a business's Gmail, Microsoft 365 or IMAP mailbox, classifies what comes in and drafts a reply in that business's voice — queued for one-click approval, or sent automatically under rules the owner sets. Self-hosted, so client email never leaves our server. Mailbox credentials are encrypted at rest.",
    facts: ["Gmail, Microsoft 365 and IMAP", "Multi-business from the ground up", "Approve or auto-send by rule", "Companion app in progress"],
    status: "in-build",
    screenshots: shots("lima"),
  },
  {
    slug: "bizzflow",
    name: "BizzFlow",
    domain: "bizzflowuk.com",
    url: "https://bizzflowuk.com",
    tagline: "White-label websites and CRM for the trades.",
    description:
      "One platform that gives a rendering, roofing or landscaping firm a complete website under their own brand, a CRM for leads, quotes and projects, and a portal where homeowners follow their job. One deployment serves every tenant, and one owner can run several businesses from a single login.",
    facts: ["Website, CRM and customer portal", "Render visualiser and cost calculator", "AMO Rendering and AMO Services live", "Google Ads run alongside"],
    status: "live",
    screenshots: shots("bizzflow"),
  },
  {
    slug: "launchos",
    name: "LaunchOS",
    domain: "os.launchflow.co.uk",
    url: "https://os.launchflow.co.uk/sign-in",
    tagline: "The portal every LaunchFlow client gets.",
    description:
      "The system this agency runs on, and the website you are reading. Clients sign in to raise support cases, see the plan they are on, approve the month's content, read reports and pay invoices. Behind it, AI agents watch uptime, triage support and write content — and nothing reaches a client without a human approving it.",
    facts: ["Support, plan, content and invoices in one place", "Uptime monitoring and incidents", "Ad reports every month", "Every agent action approved by a person"],
    status: "live",
    screenshots: shots("launchos"),
  },
  {
    slug: "funnel-engine",
    name: "Funnel Engine",
    domain: "launchflow.co.uk",
    url: "https://launchflow.co.uk/products",
    tagline: "Lead funnels for the trades, one question per screen.",
    description:
      "Mobile-first landing funnels for paid ads: five or six screens, one question each, with the contact step in the middle rather than the end so a visitor who leaves early still leaves a name and a number. Each client is a single config file. Answers are scored and a hot lead emails the owner straight away.",
    facts: ["Config-driven, no CMS", "Contact captured mid-funnel", "Lead scoring and instant alerts", "First funnel built for KD Essex"],
    status: "in-build",
    screenshots: shots("funnel-engine"),
  },
  {
    slug: "takeaway-platform",
    name: "Takeaway ordering platform",
    domain: "farm-pizza.shop",
    url: "https://farm-pizza.shop",
    tagline: "Direct ordering for takeaways, without the aggregator's cut.",
    description:
      "A storefront, kitchen screen and back office for a takeaway, with Apple Pay and Google Pay, automated win-back and quiet-night campaigns, abandoned-basket recovery and search built in. Everything per shop is configuration, so the next shop is a folder and a deploy. Farm Pizza is the first tenant.",
    facts: ["Next.js and Stripe", "Kitchen pass screen", "Marketing automations built in", "Customer app specified"],
    status: "in-testing",
    screenshots: shots("takeaway-platform"),
  },
  {
    slug: "yournanny",
    name: "YourNanny",
    domain: "yournanny.co.uk",
    url: "https://yournanny.co.uk",
    tagline: "A commission-free back office for nannies and childminders.",
    description:
      "A public profile in a searchable directory, an enquiry inbox, a booking tracker with recurring sessions and conflict detection, parent and child records, and reviews — for self-employed nannies and registered childminders who keep their full rate.",
    facts: ["Enquiry to booking in one click", "Weekly and fortnightly recurrence", "Audit trail on every booking", "Payments being wired up"],
    status: "in-testing",
    screenshots: shots("yournanny"),
  },
] as const;
