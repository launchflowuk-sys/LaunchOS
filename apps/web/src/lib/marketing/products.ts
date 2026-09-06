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
  /** The market it serves, as the small label above the name: TRANSPORT, VOICE AI. */
  category: string;
  /** One sentence for a card, shorter than `description`. */
  oneLine: string;
  /** On the home page grid. Four at most; the rest are listed as "also taking shape". */
  flagship: boolean;
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
    category: "Transport",
    oneLine: "The dispatch platform our own taxi firm runs on, sold to other UK operators as a subscription.",
    flagship: true,
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
    category: "Voice AI",
    oneLine: "Answers a business’s calls, quotes a price and writes the booking into the back office.",
    flagship: true,
    status: "live",
    screenshots: shots("agent-zero"),
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
    category: "For the trades",
    oneLine: "A complete website, CRM and customer portal for a trade firm, under its own brand.",
    flagship: true,
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
    category: "Client experience",
    oneLine: "The portal every LaunchFlow client gets: support, plan, content, reports and invoices.",
    flagship: true,
    status: "live",
    screenshots: shots("launchos"),
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
    category: "Food ordering",
    oneLine: "Direct ordering, a kitchen screen and marketing automations, without the aggregator’s cut.",
    flagship: false,
    status: "in-testing",
    screenshots: shots("takeaway-platform"),
  },
] as const;

export const FLAGSHIP_PRODUCTS: readonly Product[] = PRODUCTS.filter((product) => product.flagship).slice(0, 4);
export const UPCOMING_PRODUCTS: readonly Product[] = PRODUCTS.filter((product) => !product.flagship);
