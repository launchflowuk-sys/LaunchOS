import manifest from "./screenshots.json";

/**
 * The portfolio. Typed objects rather than a CMS: there are a dozen
 * projects, Shoji is the only editor, and a pull request is a better audit
 * trail than a database for copy that describes clients by name.
 *
 * Screenshots are not listed here by hand. `scripts/capture-portfolio.ts`
 * visits every live URL, writes `public/work/<slug>-{desktop,mobile}.jpg`,
 * and records what it managed to capture in `screenshots.json`; a project
 * whose site was down gets no entry and the page shows a placeholder card
 * rather than a broken image.
 */

export type WorkKind = "client" | "product";
export type WorkStatus = "live" | "in-build" | "in-testing" | "discovery";

export type WorkScreenshots = { desktop?: string; mobile?: string };

export type WorkItem = {
  slug: string;
  name: string;
  /** Who it was for. For our own products, "LaunchFlow". */
  client: string;
  sector: string;
  /** The live address, or null when there is nothing public to link to. */
  url: string | null;
  /** One line for a card. */
  summary: string;
  /** The brief, in the order an agency page reads it. */
  brief: {
    client: string;
    problem: string;
    built: string;
    results: string;
  };
  stack: readonly string[];
  year: number;
  screenshots: WorkScreenshots;
  /** On the home page. Four at most. */
  featured: boolean;
  kind: WorkKind;
  status: WorkStatus;
  /** Built free, for the community. Said plainly on the card and the brief. */
  charity?: boolean;
};

const SHOTS = manifest as Record<string, WorkScreenshots>;
function shots(slug: string): WorkScreenshots {
  return SHOTS[slug] ?? {};
}

export const STATUS_LABEL: Record<WorkStatus, string> = {
  live: "Live",
  "in-build": "In build",
  "in-testing": "In testing",
  discovery: "In discovery",
};

export const WORK: readonly WorkItem[] = [
  {
    slug: "grays-cabline",
    name: "Grays CabLine",
    client: "Grays CabLine",
    sector: "Taxi and airport transfers",
    url: "https://grayscabline.co.uk",
    summary: "Online booking with instant fares, card payment and a dispatch office behind it, for a Thurrock taxi firm.",
    brief: {
      client:
        "Grays CabLine is a licensed taxi and airport-transfer firm in Grays, Essex — and it is Shoji's own company, run as an owner-driver for nine years. It was the first business LaunchFlow ever built for.",
      problem:
        "The old WordPress site took bookings by phone and a slow third-party dispatch plugin. Customers wanted a price before they rang, drivers wanted jobs on their phones, and the office wanted to stop retyping everything.",
      built:
        "A thirty-page site with a four-step booking engine: address lookup, a pricing engine that quotes by distance, vehicle choice, then card, cash or pay-later. Airport pages for Heathrow, Gatwick, Stansted, Luton and Southend. Behind it, a PIN-protected dispatch office for bookings, drivers, pricing and reports, a customer tracking page for every job, and conversion events wired into Google Ads.",
      results:
        "Ranks on the first page for its local searches, and enquiries and bookings both rose after the move. The dispatch side grew into Cabio, our multi-tenant platform, which the firm now runs on.",
    },
    stack: ["React", "Express", "PostgreSQL", "Square payments", "Google Maps", "Expo", "Coolify"],
    year: 2026,
    screenshots: shots("grays-cabline"),
    featured: true,
    kind: "client",
    status: "live",
  },
  {
    slug: "lakeside-purfleet-taxis",
    name: "Lakeside & Purfleet Taxis",
    client: "Lakeside & Purfleet Taxis Ltd",
    sector: "Taxi",
    url: "https://lakesidetaxi.co.uk",
    summary: "A lead-generation site with a five-step quote form and an admin panel for following every enquiry up.",
    brief: {
      client: "Lakeside & Purfleet Taxis is a taxi operator covering Lakeside, Purfleet and the rest of Thurrock.",
      problem:
        "They wanted enquiries captured online, around the clock, without taking on a live booking and payment system they were not ready to run.",
      built:
        "Thirty-odd pages — services, six airport pages, nine area pages — fronted by a five-step quote form that writes straight into a leads database. Staff sign in to filter leads, set a status, add notes, record the quoted price and the driver, and email the customer back from the same screen. A stats dashboard shows the week at a glance.",
      results: "Live on our servers with nightly backups. Enquiry capture with manual follow-up, exactly as briefed, with online payment ready to switch on later.",
    },
    stack: ["React", "Express", "PostgreSQL", "Docker", "Coolify"],
    year: 2026,
    screenshots: shots("lakeside-purfleet-taxis"),
    featured: false,
    kind: "client",
    status: "live",
  },
  {
    slug: "star-grooming",
    name: "Star Grooming",
    client: "Star Grooming",
    sector: "Cat grooming",
    url: "https://starcatgrooming.com",
    summary: "A marketing site and booking form with a back office that reads the inbox, runs live chat and tracks every lead.",
    brief: {
      client: "Star Grooming is a cat-only groomer in Essex, run by Jade.",
      problem:
        "Enquiries arrived by email, Facebook, text and phone, and some were lost. Jade needed a professional site and one place to see every lead and answer it.",
      built:
        "A premium site with service, breed and location pages for search, a gallery and reviews, plus an online booking form with photo attachments. The admin dashboard has a lead pipeline (new, contacted, offered, booked), customer records, an inbox that reads and replies to the business email in-app, live chat with an AI assistant that hands over to Jade the moment she replies, and email and SMS alerts.",
      results: "Every enquiry lands in one pipeline with a status, and the AI chat answers the questions Jade used to answer twenty times a day.",
    },
    stack: ["React", "Express", "PostgreSQL", "OpenAI", "Twilio", "Coolify"],
    year: 2026,
    screenshots: shots("star-grooming"),
    featured: true,
    kind: "client",
    status: "live",
  },
  {
    slug: "be-gorgeous-by-monika",
    name: "Be Gorgeous by Monika",
    client: "Be Gorgeous by Monika",
    sector: "Beauty salon",
    url: "https://begorgeousbymonika.com",
    summary: "A salon booking system with a diary, client records, payments and branded confirmation emails.",
    brief: {
      client: "Be Gorgeous by Monika is a beauty and aesthetics salon in Grays, Essex.",
      problem: "Bookings lived in messages and a paper diary. Double bookings happened, reminders were manual, and there was no record of who had what done.",
      built:
        "A public booking site and a back office: the diary, client records, services, staff, opening hours, payments and notifications. Bookings create and update client records automatically; the bookings table filters, sorts, totals and exports to CSV. Every confirmation and reminder email was rebuilt and can be previewed in one command. The system was then generalised so it can carry more than one salon.",
      results: "Live for the salon, with the diary running the day. Now the base of our salon product.",
    },
    stack: ["React", "Express", "PostgreSQL", "Caddy", "Coolify"],
    year: 2026,
    screenshots: shots("be-gorgeous-by-monika"),
    featured: true,
    kind: "client",
    status: "live",
  },
  {
    slug: "thurrock-tuition-academy",
    name: "Thurrock Tuition Academy",
    client: "Thurrock Tuition Academy",
    sector: "Private tuition",
    url: "https://thurrocktuitionacademy.co.uk",
    summary: "A landing page, an admin dashboard and a parent portal for a Grays tutoring business.",
    brief: {
      client: "Thurrock Tuition Academy is Khadija's private tutoring business in Grays.",
      problem: "She needed more than a brochure: somewhere to take enquiries, keep track of students and sessions, and let parents see progress and payments.",
      built:
        "Three surfaces on one app. A public page with subjects, levels, pricing and a WhatsApp booking button. An admin dashboard for enquiries, students, sessions, progress, tasks and payments. A parent portal, gated by sign-in, where each family sees only their own children. Auth is our own, with roles assigned at sign-up.",
      results: "Live at thurrocktuitionacademy.co.uk, and the first site moved from Replit onto our own servers — the lowest-risk one, so the pipeline was proven before the bigger sites followed.",
    },
    stack: ["React", "Express", "PostgreSQL", "Tailwind", "Docker"],
    year: 2026,
    screenshots: shots("thurrock-tuition-academy"),
    featured: false,
    kind: "client",
    status: "in-build",
  },
  {
    slug: "grays-park-masjid",
    name: "Grays Park Masjid",
    client: "Grays Park Masjid",
    sector: "Community and charity",
    url: "https://graysparkmasjid.org.uk",
    summary: "A public website, an admin system and a companion app for the local masjid — built free, as charity.",
    brief: {
      client: "Grays Park Masjid is the mosque and community organisation in Grays. It is where Shoji prays, and the work was done for nothing.",
      problem: "Membership, donations and announcements were handled offline. Applicants had no way to check where their membership stood, and prayer times had to be looked up elsewhere.",
      built:
        "A public site with prayer times, announcements, events, a gallery, a membership form with a status lookup that needs no account, and one-off or recurring donations through Square. An admin dashboard runs the membership approval workflow, all content, staff and volunteers, donation records and notifications. A companion app with prayer times, Qibla, donations and reading is prepared for the stores.",
      results: "Everything the masjid publishes now goes through one dashboard, and donations are taken online. The app is in store submission.",
    },
    stack: ["React", "Express", "PostgreSQL", "Square", "Expo", "Coolify"],
    year: 2026,
    screenshots: shots("grays-park-masjid"),
    featured: false,
    kind: "client",
    status: "live",
    charity: true,
  },
  {
    slug: "nexus-education-group",
    name: "Nexus Education Group",
    client: "Nexus Education Group",
    sector: "Education consultancy",
    url: "https://nexusedu.co.uk",
    summary: "A study-abroad platform: course directory, applications, document vault, an AI assistant and a staff dashboard.",
    brief: {
      client: "Nexus Education Group helps students from Islamabad, Rawalpindi and Chakwal apply to universities in the UK, USA, Canada, Australia and Europe.",
      problem: "Student intake ran on WhatsApp and spreadsheets. Documents went missing, enquiries arrived at every hour, and nobody could see the pipeline.",
      built:
        "A course and university directory, application and consultation flows, a document vault for student uploads, and an AI assistant that answers questions and hands over leads. Staff sign in to a dashboard with owner, admin and staff roles and a full audit log. Branded notifications go out for every enquiry, application and upload. A student app talks to the same API.",
      results: "Live and the most actively developed client platform we run, with the marketing site and the student app being merged into one system.",
    },
    stack: ["React", "Express", "PostgreSQL", "Claude API", "Google Places", "Coolify"],
    year: 2026,
    screenshots: shots("nexus-education-group"),
    featured: true,
    kind: "client",
    status: "live",
  },
  {
    slug: "mobile-pc-doctor",
    name: "Mobile PC Doctor",
    client: "Mobile PC Doctor",
    sector: "Computer repair",
    url: "https://mpcdoctor.com",
    summary: "A repair-shop system where every job and every message has a running clock, on the web and in an app.",
    brief: {
      client: "Mobile PC Doctor is a computer repair business in Grays — another of our own.",
      problem: "Jobs were lost to unanswered messages, and repairs ran quietly late because nobody was watching a promised date.",
      built:
        "A booking, job-tracking, messaging and payments system built round one idea: a clock on everything. A response clock runs while a customer waits to hear back; a delivery clock runs from the moment a quote promises a date. Anything overdue appears on a staff Today screen and buzzes the phone. Enquiries arrive from a web form, from SMS and from the app into one inbox, and a customer who enquired on the web finds the conversation waiting when they install the app.",
      results: "The website and booking are live at mpcdoctor.com. The app is in TestFlight with the shop: customer and staff share one app, role-switched, alongside an owner dashboard.",
    },
    stack: ["Expo", "Express", "PostgreSQL", "Twilio", "React"],
    year: 2026,
    screenshots: shots("mobile-pc-doctor"),
    featured: false,
    kind: "client",
    status: "live",
  },
  {
    slug: "kd-essex",
    name: "KD Essex Landscaping",
    client: "KD Essex Landscaping & Groundworks",
    sector: "Landscaping and groundworks",
    url: "https://bizzflowuk.com/site/kd-essex",
    summary: "Research first, then a site on our BizzFlow platform that positions the firm where nobody else is.",
    brief: {
      client: "KD Essex is a landscaping, driveway and groundworks contractor in Thurrock and South Essex.",
      problem: "Every paving firm in Grays fights for the same map pack on proximity alone. KD needed a website, but first it needed a reason to be chosen.",
      built:
        "Before a line of the site, a research deck: competitors, reviews and searches across Thurrock and South Essex. The finding was that groundworks in the region is commercially unclaimed — the landscapers cannot dig and the groundworkers cannot finish. The plan positions KD as the one contractor who does the foundations, drainage and levels and then finishes the garden or driveway on top. The site itself runs on BizzFlow, our white-label platform for the trades: public site, enquiry capture and a CRM behind it, live in days rather than weeks.",
      results: "Research and build plan delivered as a client deck; site live on BizzFlow.",
    },
    stack: ["Research", "BizzFlow", "Google Ads"],
    year: 2026,
    screenshots: shots("kd-essex"),
    featured: false,
    kind: "client",
    status: "live",
  },
  {
    slug: "farm-pizza",
    name: "Farm Pizza",
    client: "Farm Pizza",
    sector: "Takeaway",
    url: "https://farm-pizza.shop",
    summary: "Direct online ordering for a pizza takeaway — the first shop on our takeaway platform.",
    brief: {
      client: "Farm Pizza is a pizza takeaway trading in Basildon and Grays.",
      problem: "Orders came through aggregator apps that took a cut of every sale and kept the customer.",
      built:
        "A storefront with the full menu, Apple Pay and Google Pay, a kitchen pass screen and a back office. The back office does marketing as well as orders: automations that win back lapsed customers, nudge one-timers and fill quiet nights, one-off campaigns to nine customer segments, and abandoned-basket recovery. Search is built in with server-rendered menus, structured data and a page per locality. The whole thing is config-driven, so the next takeaway is a folder and a deploy.",
      results: "Live and in final testing with the shop before card payments switch on. A customer app is specified next.",
    },
    stack: ["Next.js", "PostgreSQL", "Stripe", "Resend", "Twilio", "Coolify"],
    year: 2026,
    screenshots: shots("farm-pizza"),
    featured: false,
    kind: "client",
    status: "in-testing",
  },
  {
    slug: "amo-rendering",
    name: "AMO Rendering",
    client: "AMO Rendering",
    sector: "Rendering and construction",
    url: "https://amorendering.co.uk",
    summary: "A full trade website, CRM and customer portal on BizzFlow, plus Google Ads that bring the work in.",
    brief: {
      client: "AMO Rendering is an external-wall rendering firm in Grays, with a sister construction business, AMO Services. Both are run by Mark from one login.",
      problem: "A rendering firm needs a site that sells five kinds of render to homeowners who do not know the difference, a way to quote fast, and adverts that do not waste money.",
      built:
        "AMO was the first tenant on BizzFlow, our white-label platform for the trades. The site has service pages, area pages, a gallery, reviews, case studies, a render colour visualiser and a cost calculator, with quote forms feeding a CRM pipeline. Homeowners track their job in a customer portal. We also run the Google Ads: keyword, ad and negative lists rebuilt from scratch, with a monthly report.",
      results: "Two businesses live on one platform. Google Business Profile, site and ads now agree on the same address and the same story.",
    },
    stack: ["BizzFlow", "React", "Express", "PostgreSQL", "Google Ads", "Coolify"],
    year: 2026,
    screenshots: shots("amo-rendering"),
    featured: false,
    kind: "client",
    status: "live",
  },
] as const;

export const FEATURED_WORK: readonly WorkItem[] = WORK.filter((item) => item.featured).slice(0, 4);

export function findWork(slug: string): WorkItem | null {
  return WORK.find((item) => item.slug === slug) ?? null;
}

export const WORK_SLUGS: readonly string[] = WORK.map((item) => item.slug);
