/** What LaunchFlow does, in the order a buyer should read it. */
export type Service = {
  slug: string;
  name: string;
  summary: string;
  detail: string;
  points: readonly string[];
};

export const SERVICES: readonly Service[] = [
  {
    slug: "web-applications",
    name: "Web applications",
    summary: "Booking systems, dispatch, portals, CRMs — the software your business actually runs on.",
    detail:
      "Most of what we build now is a full application: a public front end, a back office, a database and the jobs that run overnight. We have built a taxi dispatch platform, a salon booker, a takeaway ordering system and a student CRM this way. Faster to build than a plugin-heavy site, and far easier to look after once it is live.",
    points: ["Next.js, React and TypeScript", "PostgreSQL on our own servers", "Payments with Stripe", "Multi-tenant when you need to sell it on"],
  },
  {
    slug: "mobile-apps",
    name: "Mobile apps",
    summary: "iOS and Android apps built with Expo, shipped to the App Store and Google Play.",
    detail:
      "Our own dispatch platform has a driver and passenger app live on both stores, and our takeaway platform has a customer app in the works. We build one codebase, test on real phones, and handle the store submissions so you do not have to learn them.",
    points: ["One codebase for both platforms", "Push notifications and live location", "App Store and Play Store submissions handled", "Over-the-air updates for small fixes"],
  },
  {
    slug: "websites-and-hosting",
    name: "Websites and hosting",
    summary: "A fast website on our own servers, monitored around the clock.",
    detail:
      "Fifteen years of building websites for local businesses, now hosted on our own Hetzner servers rather than shared hosting. Every site is deployed through Coolify, backed up nightly and checked every few minutes by our uptime monitor. If it goes down we know before you do.",
    points: ["Own servers, not shared hosting", "Uptime monitoring with incident alerts", "Nightly backups", "Domains and DNS looked after"],
  },
  {
    slug: "design",
    name: "Design",
    summary: "Clean, professional and quick to read on a phone.",
    detail:
      "We design for the person who lands on your site from Google on a bus. Clear hierarchy, one strong call to action, and a look that fits your trade rather than a template. Logos, brand colours and print-ready assets when you need them.",
    points: ["Mobile-first layouts", "Brand and logo work", "Accessible colour and type", "Nothing that slows the page down"],
  },
  {
    slug: "ad-management",
    name: "Ad management",
    summary: "Google and Meta campaigns, run properly, with a monthly report you can read.",
    detail:
      "We run search and social campaigns for local businesses and watch the spend daily. Our ad sentinel flags a campaign that stops converting before the month's budget is gone. You get a plain-English report every month: what was spent, what it brought in, what changes next.",
    points: ["Google Ads and Meta Ads", "Conversion tracking set up correctly", "Daily spend checks", "Monthly report in your portal"],
  },
  {
    slug: "ai-agents",
    name: "AI agents",
    summary: "Agents that answer the phone, triage support and write your monthly content.",
    detail:
      "We run AI agents in our own business every day: a phone agent that answers and books, a support agent that reads incoming email and drafts the reply, and a content writer that produces the month's posts for approval. Nothing goes out to a customer without a human saying yes.",
    points: ["Phone agent that answers and books", "Support triage with drafted replies", "Monthly content written for your approval", "Every action logged and approved"],
  },
  {
    slug: "ongoing-care",
    name: "Ongoing care",
    summary: "A support portal, monthly content and uptime, on a plan you can cancel.",
    detail:
      "Every client gets a portal: raise a support case, see what we are working on, read the monthly report, pay an invoice. Content goes out on schedule, the site stays patched, and you have one place to ask for anything.",
    points: ["Client portal with support cases", "Monthly blog, social and Google Business posts", "Security updates and patching", "Plain monthly invoice, cancel any time"],
  },
] as const;
