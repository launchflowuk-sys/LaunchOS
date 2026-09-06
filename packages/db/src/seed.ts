/**
 * Development seed: one organisation, the owner account, two real clients with
 * a site, an uptime monitor and a routable support address each, a small
 * knowledge base, one support case that arrived by email, all three agents
 * enabled, a portal login, and enough billing, ads and reporting data for
 * every screen to have something on it.
 *
 * It does **not** create the `unmatched` holding client. That bucket is not a
 * real client — it renders in /clients, in the case filter and in search like
 * one — and `ingestInboundEmail` creates it on demand the first time mail
 * arrives for an address we do not route, so pre-creating it only ever added a
 * phantom third client to installs that never needed it.
 *
 * Idempotent: every step looks the row up (by slug / email / name / target /
 * calendar month) before inserting, so `pnpm db:seed` can be run repeatedly.
 *
 * The organisation comes from SEED_ORG_NAME / SEED_ORG_SLUG, read through the
 * same helper `pnpm db:bootstrap` uses, so seeding a bootstrapped database
 * fills the organisation that is already there instead of creating a second
 * one beside it. Defaults are unchanged: "LaunchFlow" / "launchflow".
 *
 * The owner's address comes from SEED_OWNER_EMAIL, which keeps a development
 * default here — `pnpm db:bootstrap`, the production tool, has none — and is
 * *required* when the target is production. A value that is not an address is
 * refused in every environment.
 *
 * The owner password comes from SEED_OWNER_PASSWORD (default "change-me-now")
 * and the portal login's from its own SEED_CLIENT_PASSWORD (default
 * "change-me-client") — never the owner's, because those two accounts are on
 * opposite sides of a privilege boundary. Never commit a real password here.
 * **In every environment** both must clear MIN_PASSWORD_LENGTH, the same floor
 * `apps/web/src/lib/auth.ts` enforces on every other account.
 *
 * **This script refuses to run at all unless SEED_DEMO=1** — the `demo-opt-in`
 * guard, in every environment, against every host, before a connection is
 * opened. That flag is the *gate*, and it is the only guard that can be trusted
 * on its own, because **no host string can tell a local database from a live
 * one**: `ssh -L 5433:<coolify-postgres>:5432` presents production as
 * `localhost:5433`, a Hetzner private network is `10.0.0.0/16`, and
 * `infra/docker-compose.coolify.yml` — this repository's own *production*
 * topology — names its database host `postgres`. Each reads as local, so the
 * old `demo-fixtures-in-production` gate was one tunnel away from writing demo
 * invoices numbered from a live sequence into a live tenant. An affirmative
 * flag is a sentence the operator has to type; a hostname is a guess. That gate
 * is gone and this one replaces it.
 *
 * The seed's two **credential** refusals — `published-default` and
 * `shared-password`, in `assertSeedPasswords` — are kept on top of it as belt
 * and braces. A host guess cannot be the only thing between a published
 * password and a live database, but it is worth having *beside* the flag: the
 * plainly-detectable production shapes (`NODE_ENV=production`, or a database
 * that is not demonstrably local) are exactly the ones where a carried-across
 * `SEED_DEMO=1` from `.env.example` would otherwise write an owner account on
 * `change-me-now` — a password printed in this repository and in `README.md`.
 * Being wrong the local way costs the developer nothing, because those two
 * conditions cannot fire on a laptop's docker Postgres.
 *
 * The cost is nothing locally: `.env.example` ships SEED_DEMO=1, so the quick
 * start is still `cp .env.example .env` and `pnpm db:seed`. `docs/DEPLOYMENT.md`
 * says the variable must never be set on a production resource, where the entry
 * point is `pnpm db:bootstrap` (`./bootstrap.ts`) — the organisation and the
 * owner account and nothing else, with unconditional guards of its own for the
 * same reason. The two share their organisation, user and membership helpers,
 * so a bootstrapped database and a seeded one are the same shape underneath.
 *
 * `isProductionTarget` (`./env-target.ts`) survives here for exactly three
 * things and guards nothing else: the `(production target)` / `(local)`
 * annotation on the printed database line, the requirement that
 * SEED_OWNER_EMAIL be *set* rather than defaulted when the target is not
 * demonstrably local, and the two credential refusals above. Being wrong about
 * a host in any of the three costs a local developer one environment variable
 * or nothing at all, which is the only direction that inference is worth
 * having in.
 *
 * Every refusal names the guard that tripped and exits non-zero.
 *
 * This file imports `@launchos/core` and `@launchos/integrations`, which are
 * dev dependencies of `packages/db`. The seed is a dev script, so this does not
 * invert the shipped `core → db` dependency direction.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildClientReport, createAdAccount, createFunnel, createInvoiceFromSubscription, createKnowledgeArticle,
  createSubscription, ensureEmailIdentity, ingestDailyCampaignMetrics, ingestDailyMetrics,
  ingestInboundEmail, markInvoiceSent, monthPeriod, publishClientReport, recordPayment,
  seedCaseStudies, setFunnelStatus,
} from "@launchos/core";
import { MockAdsAdapter, MockPaymentsAdapter } from "@launchos/integrations";
import { hashPassword } from "better-auth/crypto";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import {
  assertOrganisationSlug, assertOwnerEmail, BootstrapGuardError, CREDENTIAL_ISSUER, CREDENTIAL_PROVIDER,
  describeDatabase, ensureOrganisation, ensureOwnerCredential, ensureOwnerMembership, ensureUserRow,
  loadRootEnv, organisationFromEnv, ownerPasswordSource, ROOT_ENV_FILE,
} from "./bootstrap.js";
import { createDb } from "./client.js";
import { isProductionTarget, productionTargetReason } from "./env-target.js";
import {
  DEFAULT_CLIENT_PASSWORD, DEFAULT_OWNER_EMAIL, DEFAULT_OWNER_PASSWORD, isPublishedDefaultPassword,
  MIN_PASSWORD_LENGTH, shortPasswordMessage,
} from "./passwords.js";
import * as schema from "./schema/index.js";

const OWNER_NAME = "Shoji";
// Enabled up front so the events that dispatch them have somewhere to land:
// `incident.opened` for the Guard-Dog, `ticket.created` for Support Triage.
// The Sentinel is enabled beside its ad data, in `seedBillingAndAds`.
const AGENT_KEYS = ["hosting-guard-dog", "support-triage"] as const;
const SENTINEL_AGENT_KEY = "ad-performance-sentinel";

/** Everything this seed reads from the environment, in one value. */
export interface SeedConfig {
  organisation: { name: string; slug: string };
  ownerEmail: string;
  ownerName: string;
  ownerPassword: string;
  clientUser: { email: string; name: string; password: string };
}

/**
 * The configuration, read **inside `main`** rather than at module scope.
 *
 * Module scope meant that merely importing this file — which
 * `seed.test.ts` does, to reach the helpers below — called `loadRootEnv()` and
 * mutated `process.env` for the whole test process as a side effect of
 * collecting the file.
 *
 * The organisation comes from the same helper `pnpm db:bootstrap` uses.
 * Hardcoding "launchflow" here meant a developer who bootstrapped `acme` and
 * then seeded got a *second* organisation holding every fixture, and signed in
 * to the empty one.
 *
 * The owner's address keeps a default here and **only** here:
 * `pnpm db:bootstrap`, the production entry point, has none at all, because a
 * forgotten variable there would create a live tenant's one privileged account
 * under an address committed to this repository. These fixtures are
 * development-only, so the default costs nothing — but the moment the target is
 * production (`SEED_DEMO=1` is the only way to get that far) `main` requires
 * `SEED_OWNER_EMAIL` to have been set. An empty value falls back like
 * `SEED_ORG_NAME` rather than surviving as `""`: `.env.example` ships the key
 * blank, and a blank key must not break `pnpm db:seed`.
 *
 * The portal login gets its **own** password, never the owner's. The two
 * accounts sit on opposite sides of a privilege boundary: the owner sees every
 * client, every invoice and every approval, while this one sees one client's
 * portal. Deriving the client password from the owner's — as this once did —
 * meant handing a client credentials that also opened the admin shell as the
 * owner. The default address is `.example` so the seed cannot create a login on
 * a real, deliverable client domain.
 */
export function seedConfigFromEnv(env: NodeJS.ProcessEnv): SeedConfig {
  const ownerEmail = env.SEED_OWNER_EMAIL?.trim();
  return {
    organisation: organisationFromEnv(env),
    ownerEmail: ownerEmail === undefined || ownerEmail === "" ? DEFAULT_OWNER_EMAIL : ownerEmail,
    ownerName: OWNER_NAME,
    ownerPassword: env.SEED_OWNER_PASSWORD ?? DEFAULT_OWNER_PASSWORD,
    clientUser: {
      email: env.SEED_CLIENT_EMAIL ?? "portal@grayscabline.example",
      name: "Grays CabLine portal",
      password: env.SEED_CLIENT_PASSWORD ?? DEFAULT_CLIENT_PASSWORD,
    },
  };
}

/**
 * The gate on this script: `SEED_DEMO=1`, or it does not run.
 *
 * **Unconditional** — no environment branch, no host check — and called before
 * `createDb`, so a refusal never opens a connection. Its predecessor,
 * `demo-fixtures-in-production`, fired only against a "production target",
 * which meant a live database reached through an SSH tunnel, over a private
 * network, or by the compose hostname `postgres` skipped it entirely and took
 * demo invoices and a repository-published owner credential into a live tenant.
 * This guard replaces it, because it asks the only question a host string
 * cannot answer.
 *
 * It is the gate but not the whole of the protection: `assertSeedPasswords`
 * still refuses a published or shared credential on the production shapes a
 * host string *can* recognise, so a `SEED_DEMO=1` carried across from
 * `.env.example` into a production resource does not by itself install an owner
 * account on `change-me-now`.
 *
 * Exactly `"1"`, not "any truthy value": `SEED_DEMO=0` and `SEED_DEMO=false`
 * are the shapes of someone turning it *off*, and must not be read as consent.
 *
 * `.env.example` ships the flag set, so `cp .env.example .env` is all a local
 * developer does; `docs/DEPLOYMENT.md` says a production resource must never
 * carry it.
 */
export function assertDemoOptIn(env: NodeJS.ProcessEnv): void {
  if (env.SEED_DEMO === "1") return;
  throw new BootstrapGuardError(
    "demo-opt-in",
    "pnpm db:seed writes demo clients, invoices with numbers from a live sequence, ad data, a portal " +
      "login and an owner account whose password may still be the default published in this repository. " +
      "It runs only when SEED_DEMO=1 says you meant it — in every environment, against every host, " +
      "because no hostname can tell a local database from a live one behind an SSH tunnel or a private " +
      "network. `.env.example` ships SEED_DEMO=1 for local work. On a live install use `pnpm db:bootstrap`, " +
      "which creates only the organisation and the owner account.",
  );
}

/**
 * The seed's two credential refusals, beside `demo-opt-in` rather than instead
 * of it.
 *
 * **`published-default`** — neither account this seed creates may be written
 * with a password printed in this repository. `.env.example` ships
 * `SEED_OWNER_PASSWORD=change-me-now` and `SEED_CLIENT_PASSWORD=change-me-client`,
 * both of which clear `MIN_PASSWORD_LENGTH`, and `README.md` prints the owner's.
 * Checked by *value* against every published literal (`isPublishedDefaultPassword`),
 * not by variable, so swapping the two around is caught as well.
 *
 * **`shared-password`** — the two must differ. The owner's password opens the
 * whole admin shell; the portal login is a client's credential. Satisfying
 * `published-default` by setting both to the same real value would hand a client
 * the owner's sign-in, which is the failure the separate variable exists to
 * prevent.
 *
 * **When they fire.** `NODE_ENV === "production"`, or `isProductionTarget(env)`
 * — the second already subsumes the first, and both halves are named because
 * each is a reason on its own and the next reader should not have to open
 * `./env-target.ts` to learn that. These are the production shapes a host
 * string *can* recognise; the ones it cannot (a tunnel, a private network, the
 * compose name `postgres`) are why `demo-opt-in` exists above and is
 * unconditional. Being wrong the local way is free: nobody exports
 * `NODE_ENV=production` on a laptop, and `localhost` / `postgres` / `db` /
 * RFC1918 all read as local, so `cp .env.example .env && pnpm db:seed` still
 * runs on the shipped defaults.
 *
 * Exported, and taking its environment as an argument, so both refusals can be
 * tested without a database and without `main`'s connection.
 */
export function assertSeedPasswords(env: NodeJS.ProcessEnv, config: SeedConfig): void {
  if (env.NODE_ENV !== "production" && !isProductionTarget(env)) return;
  const because = `Refusing because ${productionTargetReason(env)}.`;
  const defaulted = [
    isPublishedDefaultPassword(config.ownerPassword) ? "SEED_OWNER_PASSWORD" : null,
    isPublishedDefaultPassword(config.clientUser.password) ? "SEED_CLIENT_PASSWORD" : null,
  ].filter((name): name is string => name !== null);
  if (defaulted.length > 0) {
    throw new BootstrapGuardError(
      "published-default",
      `${defaulted.join(" and ")} ${defaulted.length > 1 ? "are" : "is"} still a default published in ` +
        "this repository. Refusing to seed an account with it. " +
        `Set them in the resource environment, run the seed once, then remove them. ${because}`,
    );
  }
  if (config.clientUser.password === config.ownerPassword) {
    throw new BootstrapGuardError(
      "shared-password",
      "SEED_CLIENT_PASSWORD must differ from SEED_OWNER_PASSWORD. " +
        "The portal login is a client's credential and the owner's opens the whole admin shell; " +
        `they must never be the same secret. ${because}`,
    );
  }
}

/**
 * The owner's address, in two parts.
 *
 * **Everywhere:** it must look like an address. Unset means the development
 * default above, which passes, so this only ever fires on a value somebody
 * actually typed — and that value is the identity of the account they will sign
 * in as, so a mangled one is worth a refusal rather than a user row nobody can
 * reach.
 *
 * **Against a production target:** `SEED_OWNER_EMAIL` must have been *set*.
 * `pnpm db:bootstrap` refuses an unset one in every environment because it has
 * no default at all; the seed keeps one for local fixtures, but a seed that has
 * reached a live database (only possible with `SEED_DEMO=1` said out loud) is
 * writing the same privileged owner account the bootstrap would, and must not
 * write it under an address committed to this repository.
 *
 * Exported, and taking its environment as an argument, so both halves can be
 * tested without a database and without `main`'s connection.
 */
export function assertSeedOwnerEmail(env: NodeJS.ProcessEnv, ownerEmail: string, productionTarget: boolean): void {
  assertOwnerEmail(ownerEmail);
  if (!productionTarget) return;
  if ((env.SEED_OWNER_EMAIL ?? "").trim() !== "") return;
  throw new BootstrapGuardError(
    "owner-email",
    "SEED_OWNER_EMAIL is not set, so the owner account would be created under the development default " +
      "committed to this repository. That account sees every client, invoice and approval in the tenant. " +
      `Set it to the address you will sign in as. Refusing because ${productionTargetReason(env)}.`,
  );
}

const AD_ACCOUNT = { platform: "google" as const, externalId: "123-456-7890", name: "Grays CabLine — Search" };
const SNAPSHOT_DAYS = 30;
const ROAS_DROP_DAYS = 7;
const VAT_RATE_PERCENT = 20;

const isoDay = (value: Date) => value.toISOString().slice(0, 10);

// Read at call time, not at module scope: `loadRootEnv()` now runs inside
// `main`, so a module-scope read would miss the value in the repo-root `.env`.
const supportEmailDomain = () => process.env.SUPPORT_EMAIL_DOMAIN ?? "support.launchflow.co.uk";

const STAFF = { email: "team@launchflow.example", name: "Sam Staff", title: "Support" } as const;

/**
 * The starting knowledge base. Support Triage searches these and quotes them
 * back to clients, so every body is real guidance written for a client to
 * read — not filler. All five are published; an unpublished article is
 * invisible to `searchKnowledge`.
 */
const KNOWLEDGE_ARTICLES = [
  {
    title: "DNS propagation after a nameserver change",
    slug: "dns-propagation",
    tags: ["dns"],
    bodyMd: `When we move a domain's nameservers, the change has to reach every DNS resolver on the internet before all your visitors see the new site. That spread is called propagation, and it is normal for it to take a few hours.

Most UK broadband and mobile networks pick the change up within one to four hours. The outer limit is 48 hours, which is how long some resolvers cache a nameserver record. Nothing is broken during that window: some people see the new site and some still see the old one, depending on which resolver they happen to use.

You can check what the rest of the world sees rather than what your own laptop has cached. \`dig NS yourdomain.co.uk +short\` from a terminal, or any online DNS checker, shows the nameservers currently being handed out. If those already show the new pair, the change has landed and the remaining wait is only cache expiry.

If it has been more than 48 hours and the old site is still showing, tell us. That usually means the registrar did not save the change, or the old host is still answering for the domain — both are things we fix at our end, not something you need to do.`,
  },
  {
    title: "Resetting a WordPress login",
    slug: "wordpress-login-reset",
    tags: ["content", "wordpress"],
    bodyMd: `If you cannot get into your WordPress dashboard, start with the built-in reset. Go to \`/wp-login.php\`, click "Lost your password?", enter the email address on your user account and follow the link WordPress sends you. The link is single-use and expires within a day.

If the reset email never arrives, check the spam folder first, then tell us. A missing reset email almost always means the site is sending mail from its own server rather than through an authenticated mailbox, which is a configuration we can correct in a few minutes.

Do not create a second administrator account to work around it. Duplicate admin accounts are the most common way a site ends up with an old, forgotten login still active months later. We would rather reset the one you already have.

We can also reset a password directly for any site we host. Ask us and we will set a temporary password, hand it over privately, and require you to change it on first sign-in.`,
  },
  {
    title: "SSL certificate renewal",
    slug: "ssl-renewal",
    tags: ["hosting", "ssl"],
    bodyMd: `Every site we host uses a Let's Encrypt certificate that renews itself automatically about 30 days before it expires. In normal running you will never see a certificate warning and there is nothing for you to do.

Renewal only fails for one of two reasons: the domain's DNS no longer points at our server, or a redirect is intercepting the \`/.well-known/acme-challenge/\` path the certificate authority uses to verify the domain. Both show up in our monitoring before a visitor ever sees a warning.

If a browser is showing you "your connection is not private", check the certificate's expiry date in the padlock menu before assuming the worst. A date in the future usually means the warning is about a different hostname — \`www\` versus the bare domain is the usual culprit — rather than an expired certificate.

Tell us as soon as you see a warning. Renewal can be forced immediately once the underlying cause is fixed, so this is normally resolved the same day.`,
  },
  {
    title: "Email deliverability: SPF, DKIM and DMARC",
    slug: "email-deliverability",
    tags: ["email"],
    bodyMd: `Three DNS records decide whether your email reaches an inbox or a spam folder. SPF lists the servers allowed to send as your domain. DKIM adds a signature that proves a message was not altered in transit. DMARC tells receiving servers what to do when a message fails the first two.

You need exactly one SPF record. Two SPF records on the same domain is a permanent failure, not a warning — if you add a new sending service, its \`include:\` goes inside the existing record rather than in a new one. End the record with \`~all\` rather than \`-all\` while you are still adding services.

DKIM is published by whoever sends your mail, usually as a CNAME your provider gives you. Once it is in place, send a message to a personal address and view the original: a healthy message shows \`spf=pass\` and \`dkim=pass\` in its authentication headers.

Start DMARC at \`v=DMARC1; p=none; rua=mailto:you@yourdomain.co.uk\`. That changes nothing about delivery but sends you reports on who is sending as your domain. Only tighten to \`quarantine\` and then \`reject\` once those reports are clean, otherwise you will block your own newsletters.`,
  },
  {
    title: "Site down: first-response checklist",
    slug: "site-down-checklist",
    tags: ["hosting"],
    bodyMd: `Our uptime monitor checks every site once a minute and opens an incident after three consecutive failures, so in most cases we already know and are working on it before you write in. Check the client portal first — an open incident there means it is in hand.

Before reporting an outage, confirm it is not just you. Load the site on mobile data with wifi turned off, and try a different browser. A site that loads on your phone but not your laptop is a local DNS or cache problem, not an outage.

Note the exact error you see, because the wording tells us where the fault is. "This site can't be reached" points at DNS or the server being down. A 500 error means the server answered but the application failed. A certificate warning is a separate problem entirely and the site itself is usually fine.

When you report it, send us the time it started, the page you were on and the exact error text. That is enough for us to open the right log straight away rather than asking you follow-up questions.`,
  },
] as const;

/**
 * One support case that arrived by email. The Message-ID is fixed rather than
 * generated, so a second `pnpm db:seed` is short-circuited by
 * `ingestInboundEmail`'s own duplicate check instead of opening a second case.
 */
const SUPPORT_EMAIL = {
  messageId: "<seed-1@grayscabline.co.uk>",
  from: "dispatch@grayscabline.co.uk",
  fromName: "Dispatch desk",
  subject: "Booking form is not emailing us",
  text:
    "Morning — a customer rang to say she filled in the booking form on the website yesterday " +
    "evening and never heard back. We have had nothing in the inbox since about 6pm. " +
    "Everything else on the site looks fine. Can you take a look?",
} as const;

const SEED_CLIENTS = [
  {
    name: "Grays CabLine",
    slug: "grays-cabline",
    email: "info@grayscabline.co.uk",
    url: "https://grayscabline.co.uk",
    contacts: [
      { name: "Shoji", email: "shujaat@nexusedu.co.uk", role: "Owner", isPrimary: true },
      { name: "Dispatch desk", email: "dispatch@grayscabline.co.uk", role: "Operations", isPrimary: false },
    ],
    // The second domain deliberately has no site: a domain can be bought first.
    domains: ["grayscabline.co.uk", "grayscabline.com"],
  },
  {
    name: "Mobile PC Doctor",
    slug: "mobile-pc-doctor",
    email: "info@mobilepcdoctor.co.uk",
    url: "https://mobilepcdoctor.co.uk",
    contacts: [
      { name: "Shoji", email: "shujaat@nexusedu.co.uk", role: "Owner", isPrimary: true },
      { name: "Workshop", email: "workshop@mobilepcdoctor.co.uk", role: "Repairs", isPrimary: false },
    ],
    domains: ["mobilepcdoctor.co.uk"],
  },
] as const;

const SEED_PACKAGES = [
  {
    slug: "website-care", name: "Website Care",
    description: "Hosting, maintenance and monthly content for a brochure site.",
    monthlyPricePence: 9900, setupPricePence: 49900,
    includes: { website: true, seo: false, ads: false, socialPostsPerMonth: 0, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
  },
  {
    slug: "website-seo-social", name: "Website + SEO + Social",
    description: "Everything in Website Care plus SEO and four social posts a month.",
    monthlyPricePence: 29900, setupPricePence: 79900,
    includes: { website: true, seo: true, ads: false, socialPostsPerMonth: 4, blogPostsPerMonth: 1, gbpUpdatesPerMonth: 2 },
  },
] as const;

// Zero to handover, in the order Shoji actually works it. All global: every
// package starts the same way.
const ONBOARDING_TEMPLATES = [
  { title: "Discovery call", kind: "other", offsetDays: 1, sortOrder: 10, defaultAssigneeRole: "owner", checklist: ["Goals", "Competitors", "Deadline"] },
  { title: "Content collection", kind: "content", offsetDays: 3, sortOrder: 20, defaultAssigneeRole: "any", checklist: ["Logo", "Photos", "Copy", "Opening hours"] },
  { title: "Design approval", kind: "review", offsetDays: 7, sortOrder: 30, defaultAssigneeRole: "owner", checklist: [] },
  { title: "Build website", kind: "build", offsetDays: 14, sortOrder: 40, defaultAssigneeRole: "any", checklist: ["Home", "Services", "Contact form", "Mobile check"] },
  { title: "DNS and hosting setup", kind: "dns", offsetDays: 16, sortOrder: 50, defaultAssigneeRole: "owner", checklist: ["Nameservers", "SSL", "Coolify resource"] },
  { title: "Deploy to production", kind: "deploy", offsetDays: 18, sortOrder: 60, defaultAssigneeRole: "any", checklist: ["Deploy", "Uptime monitor", "Backups"] },
  { title: "SEO setup", kind: "seo", offsetDays: 20, sortOrder: 70, defaultAssigneeRole: "any", checklist: ["Titles and descriptions", "Sitemap", "Search Console"] },
  { title: "Google Business Profile setup", kind: "gbp", offsetDays: 21, sortOrder: 80, defaultAssigneeRole: "any", checklist: ["Claim listing", "Categories", "Photos"] },
  { title: "Review request", kind: "review", offsetDays: 25, sortOrder: 90, defaultAssigneeRole: "any", checklist: [] },
  { title: "Handover", kind: "handover", offsetDays: 28, sortOrder: 100, defaultAssigneeRole: "owner", checklist: ["Walkthrough call", "Logins handed over", "Support address shared"] },
] as const;

// Quantities come from the package's `includes`, not from these rows.
const RECURRING_TEMPLATES = [
  { title: "Social post", kind: "social", recurrence: "monthly", sortOrder: 10, packageSlug: "website-seo-social", checklist: ["Draft", "Image", "Schedule"] },
  { title: "Blog post", kind: "content", recurrence: "monthly", sortOrder: 20, packageSlug: null, checklist: ["Outline", "Draft", "Publish"] },
  { title: "Google Business Profile update", kind: "gbp", recurrence: "monthly", sortOrder: 30, packageSlug: null, checklist: [] },
  { title: "SEO audit", kind: "seo", recurrence: "quarterly", sortOrder: 40, packageSlug: "website-seo-social", checklist: ["Rankings", "Broken links", "Page speed"] },
] as const;

const CLIENT_PACKAGES: Record<string, string> = {
  "Grays CabLine": "website-seo-social",
  "Mobile PC Doctor": "website-care",
};

async function main() {
  // Inside `main`, not at module scope: importing this file must not mutate
  // the importer's environment.
  const envFile = loadRootEnv();
  const config = seedConfigFromEnv(process.env);
  const url = process.env.DATABASE_URL;
  if (!url) throw new BootstrapGuardError("database-url", "DATABASE_URL is required to seed");
  // Before the guards: an operator who trips one needs to know which database
  // they were pointed at and which file configured the run, which is usually
  // the actual mistake. The same lines `pnpm db:bootstrap` prints.
  const productionTarget = isProductionTarget(process.env);
  console.log("database      ", describeDatabase(url), productionTarget ? "(production target)" : "(local)");
  console.log("env file      ", envFile ?? `none found at ${ROOT_ENV_FILE}; using the process environment only`);
  console.log("password      ", ownerPasswordSource(process.env));
  // The opt-in first, because it is the one refusal that applies to running
  // this script at all rather than to how it is configured.
  assertDemoOptIn(process.env);
  // The floor next, and in every environment: both of these accounts are
  // written straight into `account`, which Better Auth never re-validates, so
  // a short password set here would stand for the life of the account. This is
  // the same constant `apps/web/src/lib/auth.ts` enforces on everyone else.
  for (const [name, value] of [
    ["SEED_OWNER_PASSWORD", config.ownerPassword],
    ["SEED_CLIENT_PASSWORD", config.clientUser.password],
  ] as const) {
    if (value.length < MIN_PASSWORD_LENGTH) {
      throw new BootstrapGuardError("password-floor", shortPasswordMessage(name, value));
    }
  }
  // The organisation this run would fill or create, in every environment. An
  // empty or malformed SEED_ORG_SLUG makes a second, nameless tenant rather
  // than finding the one that is already there.
  assertOrganisationSlug(config.organisation.slug);

  // Belt and braces beside `demo-opt-in`, on the production shapes a host
  // string can actually recognise: no account this seed creates may reach one
  // of those on a password published in this repository, and the owner's and
  // the client's may never be the same secret. Free locally — neither half of
  // `isProductionTarget` fires on a laptop's docker Postgres.
  assertSeedPasswords(process.env, config);

  // The last use of the target inference, and it decides one thing: whether
  // SEED_OWNER_EMAIL must have been *set* rather than defaulted to the address
  // this repository ships. Being wrong the local way costs one variable, which
  // is the direction this guess is worth making.
  assertSeedOwnerEmail(process.env, config.ownerEmail, productionTarget);
  console.log("organisation  ", config.organisation.slug, `(${config.organisation.name})`);

  const db = createDb(url);

  try {
    await runSeed(db, config);
  } finally {
    await db.$client.end();
  }
}

/**
 * Everything the seed writes, in the order it must be written in. Exported and
 * separate from `main` so a test can run **this** sequence — the one production
 * uses — rather than a copy of it assembled in the test file. `main` keeps the
 * environment, the guards, the log preamble and the connection.
 */
export async function runSeed(db: Db, config: SeedConfig): Promise<void> {
  const { user, organisation: created, membership } = await seedOwnerAccount(db, config);
  // The organisation's placeholder supplier details are backfilled only once
  // the owner account is settled: a refused seed must not have edited the
  // organisation row it refused to finish.
  const organisation = await backfillOrganisationSupplier(db, created);
  const enabledAgents: string[] = [];
  for (const agentKey of AGENT_KEYS) {
    const enablement = await seedAgentEnablement(db, organisation.id, agentKey);
    enabledAgents.push(`${enablement.agentKey}=${enablement.enabled}`);
  }
  const staff = await seedStaffMember(db, organisation.id);
  const packagesBySlug = await seedPackages(db, organisation.id);
  const templateCount = await seedTaskTemplates(db, organisation.id, packagesBySlug);

  console.log("organisation  ", organisation.id, organisation.slug);
  console.log("owner user    ", user.id, user.email);
  console.log("membership    ", membership.id, membership.role);
  console.log("staff member  ", staff.id, `${STAFF.email} ${staff.role}/${staff.status}`);
  console.log("agents        ", enabledAgents.join(", "));
  console.log("packages      ", [...packagesBySlug.keys()].join(", "));
  console.log("templates     ", `${templateCount} created`);

  const seededClients: { id: string; name: string; email: string; supportAddress: string | null }[] = [];
  for (const spec of SEED_CLIENTS) {
    const client = await seedClient(db, organisation.id, spec);
    const identity = await seedEmailIdentity(db, organisation.id, client.id, client.name);
    seededClients.push({
      id: client.id, name: client.name, email: client.email ?? spec.email,
      supportAddress: identity?.address ?? null,
    });
    const site = await seedSite(db, organisation.id, client.id, spec);
    const monitor = await seedMonitor(db, organisation.id, site.id, spec.url);
    const billing = await seedBillingProfile(db, organisation.id, client.id, spec.name);
    await seedContacts(db, organisation.id, client.id, spec.contacts);
    await seedDomains(db, organisation.id, client.id, site.id, spec.domains);
    await seedActivity(db, organisation.id, client.id, spec.name, site.id);
    const withPackage = await assignPackage(db, organisation.id, client, packagesBySlug.get(CLIENT_PACKAGES[spec.name]!)!.id);
    const taskCount = await seedOnboardingTasks(db, organisation.id, withPackage.id, withPackage.createdAt, user.id);
    console.log("client        ", client.id, client.name);
    console.log("  identity    ", identity ? `${identity.id} ${identity.address}` : "skipped");
    console.log("  site        ", site.id, site.primaryUrl);
    console.log("  monitor     ", monitor.id, `${monitor.target} every ${monitor.intervalSeconds}s`);
    console.log("  billing     ", billing.id, `terms ${billing.paymentTermsDays} days`);
    console.log("  contacts    ", spec.contacts.length);
    console.log("  domains     ", spec.domains.length, spec.domains.join(", "));
    console.log("  package     ", withPackage.packageId);
    console.log("  tasks       ", `${taskCount} onboarding tasks created`);
  }

  const articles = await seedKnowledgeArticles(db, organisation.id);
  console.log("knowledge     ", `${articles} of ${KNOWLEDGE_ARTICLES.length} articles created`);

  const grays = seededClients[0]!;
  const support = await seedSupportConversation(db, organisation.id, grays.supportAddress);
  console.log(
    "support case  ",
    support ? `${support.ticketId} ${support.created ? "created" : "already present"}` : "skipped",
  );

  const clientUser = await seedClientUser(db, organisation.id, grays.id, config.clientUser);
  console.log("client user   ", clientUser.id, `${config.clientUser.email} client_admin`);

  // Migration 0025 seeds the portfolio into every organisation that existed
  // when it ran; this organisation is created afterwards, so without this line
  // a freshly seeded database serves an empty Work page. Idempotent by slug,
  // so a re-seed never reverts a story that has since been rewritten.
  const portfolio = await seedCaseStudies(db, organisation.id);
  console.log("case studies  ", `${portfolio.inserted.length} written, ${portfolio.skipped} already present`);

  const funnel = await seedFunnel(db, organisation.id);
  console.log("funnel        ", funnel.id, `/f/${funnel.slug} (${funnel.status})`);

  const billing = await seedBillingAndAds(db, organisation.id, seededClients);
  // What this run created, not a constant: a second seed prints zeros, which
  // is what makes the line evidence of idempotency rather than decoration.
  // Snapshots are upserted every run, so they are reported as written.
  console.log(
    "billing/ads   ",
    `created ${billing.subscriptions} subscriptions, ${billing.invoices} invoices, ` +
      `${billing.reports} published reports; wrote ${billing.snapshots} ad snapshots ` +
      `(${billing.snapshotsInPeriod} inside the report period)`,
  );
}

type Db = ReturnType<typeof createDb>;

async function seedPackages(db: Db, organisationId: string) {
  const bySlug = new Map<string, typeof schema.packages.$inferSelect>();
  for (const spec of SEED_PACKAGES) {
    const [existing] = await db.select().from(schema.packages)
      .where(and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.slug, spec.slug)));
    if (existing) { bySlug.set(spec.slug, existing); continue; }
    const [created] = await db.insert(schema.packages).values({ organisationId, ...spec }).returning();
    bySlug.set(spec.slug, created!);
  }
  return bySlug;
}

async function seedTaskTemplates(db: Db, organisationId: string, packagesBySlug: Map<string, typeof schema.packages.$inferSelect>) {
  const rows = [
    ...ONBOARDING_TEMPLATES.map((t) => ({ ...t, phase: "onboarding" as const, recurrence: "none" as const, packageId: null })),
    ...RECURRING_TEMPLATES.map((t) => ({
      title: t.title, kind: t.kind, sortOrder: t.sortOrder, checklist: t.checklist,
      phase: "recurring" as const, recurrence: t.recurrence, offsetDays: 0,
      defaultAssigneeRole: "any" as const,
      packageId: t.packageSlug ? packagesBySlug.get(t.packageSlug)!.id : null,
    })),
  ];

  let created = 0;
  for (const row of rows) {
    const [existing] = await db.select().from(schema.taskTemplates).where(and(
      eq(schema.taskTemplates.organisationId, organisationId),
      eq(schema.taskTemplates.phase, row.phase),
      eq(schema.taskTemplates.title, row.title),
    ));
    if (existing) continue;
    await db.insert(schema.taskTemplates).values({
      organisationId, packageId: row.packageId, phase: row.phase, kind: row.kind, title: row.title,
      offsetDays: row.offsetDays ?? 0, recurrence: row.recurrence,
      defaultAssigneeRole: row.defaultAssigneeRole, sortOrder: row.sortOrder, checklist: [...row.checklist],
    });
    created += 1;
  }
  return created;
}

async function assignPackage(db: Db, organisationId: string, client: typeof schema.clients.$inferSelect, packageId: string) {
  if (client.packageId === packageId) return client;
  const [updated] = await db.update(schema.clients)
    .set({ packageId, updatedAt: new Date() })
    .where(and(eq(schema.clients.id, client.id), eq(schema.clients.organisationId, organisationId)))
    .returning();
  return updated!;
}

/**
 * Mirrors generateOnboardingTasks. `packages/db` cannot import `@launchos/core`
 * (dependency direction is core → db), so the rules live twice: due date is
 * client.created_at + offset_days, owner-role templates go to the owner, and
 * (client_id, template_id) makes it idempotent.
 */
async function seedOnboardingTasks(db: Db, organisationId: string, clientId: string, createdAt: Date, ownerUserId: string) {
  const templates = await db.select().from(schema.taskTemplates).where(and(
    eq(schema.taskTemplates.organisationId, organisationId),
    eq(schema.taskTemplates.phase, "onboarding"),
  )).orderBy(asc(schema.taskTemplates.sortOrder));

  let created = 0;
  for (const template of templates) {
    const [existing] = await db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(
      eq(schema.tasks.clientId, clientId),
      eq(schema.tasks.templateId, template.id),
    ));
    if (existing) continue;
    await db.insert(schema.tasks).values({
      organisationId, clientId, templateId: template.id, phase: "onboarding", kind: template.kind,
      title: template.title, descriptionMd: template.descriptionMd,
      dueAt: new Date(createdAt.getTime() + template.offsetDays * 86_400_000),
      assigneeUserId: template.defaultAssigneeRole === "owner" ? ownerUserId : null,
      checklist: template.checklist.map((label) => ({ label, done: false })),
      createdByKind: "system",
    });
    created += 1;
  }
  return created;
}

/**
 * Placeholder supplier details, so a seeded invoice is a complete document
 * rather than one missing the header HMRC requires. Obviously placeholder —
 * the VAT and company numbers are not real registrations — and editable on
 * Settings → Organisation, which is where the live values belong.
 */
const ORGANISATION_SUPPLIER = {
  legalName: "LaunchFlow Ltd",
  addressLine1: "Placeholder — set on Settings → Organisation",
  addressLine2: null,
  city: "Grays",
  postcode: "RM17 0AA",
  // ISO 3166-1 alpha-2, which is what `updateOrganisation` validates: a
  // country *name* here would make the first save on Settings → Organisation
  // fail on a field the operator never typed.
  country: "GB",
  vatNumber: "GB000000000",
  companyNumber: "00000000",
  invoiceFooter: "Placeholder invoice footer — set your bank details on Settings → Organisation.",
} as const;

/** What earlier seeds wrote into `country`, before it had to be alpha-2. */
const LEGACY_COUNTRY_NAME = "United Kingdom";

/**
 * The organisation, plus the placeholder supplier details every invoice screen
 * needs something in. `ensureOrganisation` is the same helper `pnpm
 * db:bootstrap` uses, so the two entry points can never create the row two
 * different ways; the supplier backfill is the part that is demo-only.
 */
export async function backfillOrganisationSupplier(db: Db, row: typeof schema.organisations.$inferSelect) {
  // Backfill only, and only when nobody has filled these in: a re-seed must
  // never overwrite the real registration details an operator has typed.
  if (row.legalName !== null) {
    // The one exception: earlier seeds wrote the country as a name, which
    // `updateOrganisation` now rejects, so the first save on Settings →
    // Organisation fails on a field nobody typed. Repair exactly that value.
    if (row.country !== LEGACY_COUNTRY_NAME) return row;
    const [repaired] = await db
      .update(schema.organisations)
      .set({ country: ORGANISATION_SUPPLIER.country, updatedAt: new Date() })
      .where(eq(schema.organisations.id, row.id))
      .returning();
    return repaired!;
  }
  const [filled] = await db
    .update(schema.organisations)
    .set({ ...ORGANISATION_SUPPLIER, updatedAt: new Date() })
    .where(eq(schema.organisations.id, row.id))
    .returning();
  return filled!;
}

/**
 * The organisation, the owner's user row, the owner membership and the owner
 * credential — in the order that is this seed's only protection.
 *
 * `runSeed` has no transaction (unlike `bootstrap()`), so the order of these
 * writes is all there is. The membership is settled **before** the credential:
 * a refusal on a membership that belongs to somebody else must not leave
 * SEED_OWNER_PASSWORD hashed onto their account, and this seed manufactures
 * exactly the account that triggers that refusal — the invited
 * `team@launchflow.example` of `seedStaffMember`.
 *
 * The organisation is *looked up* first and created only where a refusal cannot
 * strand it: against a row that is already there the membership is settled
 * before anything is written at all, and a freshly created organisation has no
 * members, so `seedMembership` cannot refuse against one. Either way a refused
 * seed leaves no new, empty tenant behind.
 */
export async function seedOwnerAccount(db: Db, config: SeedConfig) {
  const user = await seedOwnerUser(db, config);
  const [found] = await db
    .select()
    .from(schema.organisations)
    .where(eq(schema.organisations.slug, config.organisation.slug));
  if (found) {
    const membership = await seedMembership(db, found.id, user.id);
    await ensureOwnerCredential(db, user.id, config.ownerPassword);
    return { user, organisation: found, membership };
  }
  const { row } = await ensureOrganisation(db, config.organisation);
  const membership = await seedMembership(db, row.id, user.id);
  await ensureOwnerCredential(db, user.id, config.ownerPassword);
  return { user, organisation: row, membership };
}

/** The owner's user row only. `seedOwnerAccount` writes the credential after the membership. */
export async function seedOwnerUser(db: Db, config: Pick<SeedConfig, "ownerEmail" | "ownerName">) {
  const { row } = await ensureUserRow(db, { email: config.ownerEmail, name: config.ownerName });
  return row;
}

export async function seedMembership(db: Db, organisationId: string, userId: string) {
  return ensureOwnerMembership(db, organisationId, userId);
}

async function seedAgentEnablement(db: Db, organisationId: string, agentKey: string) {
  const [existing] = await db
    .select()
    .from(schema.agentEnablement)
    .where(and(eq(schema.agentEnablement.organisationId, organisationId), eq(schema.agentEnablement.agentKey, agentKey)));
  if (existing?.enabled) return existing;
  if (existing) {
    const [updated] = await db
      .update(schema.agentEnablement)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(schema.agentEnablement.id, existing.id))
      .returning();
    return updated!;
  }
  const [created] = await db
    .insert(schema.agentEnablement)
    .values({ organisationId, agentKey, enabled: true })
    .returning();
  return created!;
}

async function seedClient(db: Db, organisationId: string, spec: (typeof SEED_CLIENTS)[number]) {
  const [existing] = await db
    .select()
    .from(schema.clients)
    .where(and(eq(schema.clients.organisationId, organisationId), eq(schema.clients.name, spec.name)));
  if (existing) return existing;
  const [created] = await db
    .insert(schema.clients)
    .values({
      organisationId,
      name: spec.name,
      slug: spec.slug,
      email: spec.email,
      supportEmail: `${spec.slug}@${supportEmailDomain()}`,
    })
    .returning();
  return created!;
}

/**
 * The bucket mail to an unrouted address lands in. `ingestInboundEmail`
 * creates it on demand too, so the seed only guarantees the admin screens have
 * it before the first delivery rather than owning it.
 */
/**
 * The routable inbox behind `clients.support_email`. `ensureEmailIdentity` is
 * itself idempotent, so this only adds the guard: an invalid
 * SUPPORT_EMAIL_DOMAIN is a warning, not a reason to abandon the whole seed.
 */
async function seedEmailIdentity(db: Db, organisationId: string, clientId: string, clientName: string) {
  try {
    return await ensureEmailIdentity(db, organisationId, { clientId });
  } catch (err) {
    console.warn(
      `  warning     no support address for ${clientName}: ${err instanceof Error ? err.message : String(err)}. ` +
        "Check SUPPORT_EMAIL_DOMAIN.",
    );
    return null;
  }
}

/**
 * The starting knowledge base. `createKnowledgeArticle` appends -2, -3 … to a
 * slug that is already taken, so a re-run has to look the slug up first rather
 * than lean on the unique index.
 */
async function seedKnowledgeArticles(db: Db, organisationId: string) {
  let created = 0;
  for (const article of KNOWLEDGE_ARTICLES) {
    const [existing] = await db
      .select({ id: schema.knowledgeArticles.id })
      .from(schema.knowledgeArticles)
      .where(and(eq(schema.knowledgeArticles.organisationId, organisationId), eq(schema.knowledgeArticles.slug, article.slug)));
    if (existing) continue;
    await createKnowledgeArticle(db, organisationId, {
      title: article.title, slug: article.slug, bodyMd: article.bodyMd, tags: [...article.tags], published: true,
    });
    created += 1;
  }
  return created;
}

/**
 * One case that arrived by email, created down the real intake path so the
 * Inbox, Open Cases and the client portal all have a live thread on a fresh
 * database. The fixed Message-ID makes the second run a no-op inside
 * `ingestInboundEmail`; the lookup here only decides what to print.
 */
async function seedSupportConversation(db: Db, organisationId: string, supportAddress: string | null) {
  if (!supportAddress) return null;
  const [existing] = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(and(eq(schema.messages.organisationId, organisationId), eq(schema.messages.externalId, SUPPORT_EMAIL.messageId)));

  const result = await ingestInboundEmail(db, organisationId, {
    provider: "generic",
    to: [supportAddress],
    from: SUPPORT_EMAIL.from,
    fromName: SUPPORT_EMAIL.fromName,
    subject: SUPPORT_EMAIL.subject,
    text: SUPPORT_EMAIL.text,
    messageId: SUPPORT_EMAIL.messageId,
    references: [],
    attachments: [],
    rawHeaders: {},
  });
  return { ticketId: result.ticket.id, created: !existing };
}

async function seedSite(db: Db, organisationId: string, clientId: string, spec: (typeof SEED_CLIENTS)[number]) {
  const [existing] = await db
    .select()
    .from(schema.sites)
    .where(and(eq(schema.sites.organisationId, organisationId), eq(schema.sites.clientId, clientId), eq(schema.sites.name, spec.name)));
  if (existing) return existing;
  const [created] = await db
    .insert(schema.sites)
    .values({ organisationId, clientId, name: spec.name, primaryUrl: spec.url })
    .returning();
  return created!;
}

async function seedBillingProfile(db: Db, organisationId: string, clientId: string, billingName: string) {
  const [existing] = await db.select().from(schema.billingProfiles).where(eq(schema.billingProfiles.clientId, clientId));
  if (existing) return existing;
  const [created] = await db
    .insert(schema.billingProfiles)
    .values({ organisationId, clientId, billingName, paymentTermsDays: 14 })
    .returning();
  return created!;
}

async function seedContacts(
  db: Db,
  organisationId: string,
  clientId: string,
  contacts: readonly { name: string; email: string; role: string; isPrimary: boolean }[],
) {
  for (const contact of contacts) {
    const [existing] = await db
      .select()
      .from(schema.clientContacts)
      .where(and(eq(schema.clientContacts.clientId, clientId), eq(schema.clientContacts.name, contact.name)));
    if (existing) continue;
    await db.insert(schema.clientContacts).values({ organisationId, clientId, ...contact });
  }
}

async function seedDomains(db: Db, organisationId: string, clientId: string, siteId: string, names: readonly string[]) {
  for (const [index, name] of names.entries()) {
    const [existing] = await db
      .select()
      .from(schema.domains)
      .where(and(eq(schema.domains.organisationId, organisationId), eq(schema.domains.name, name)));
    if (existing) continue;
    await db.insert(schema.domains).values({
      organisationId,
      clientId,
      // The first domain points at the site; any extra is held without one.
      siteId: index === 0 ? siteId : null,
      name,
      registrar: "Namecheap",
      dnsProvider: index === 0 ? "cloudflare" : "registrar",
      nameservers: index === 0 ? ["ns1.cloudflare.test", "ns2.cloudflare.test"] : [],
    });
  }
}

async function seedActivity(db: Db, organisationId: string, clientId: string, clientName: string, siteId: string) {
  const [existing] = await db.select().from(schema.activityEvents).where(eq(schema.activityEvents.clientId, clientId));
  if (existing) return;
  await db.insert(schema.activityEvents).values([
    { organisationId, clientId, actorKind: "system", kind: "client.created", title: `Client created: ${clientName}`, link: `/clients/${clientId}` },
    { organisationId, clientId, siteId, actorKind: "system", kind: "site.created", title: "Website added", link: `/websites/${siteId}` },
    { organisationId, clientId, actorKind: "system", kind: "domain.created", title: "Domain added", link: `/clients/${clientId}?tab=sites` },
  ]);
}

async function seedStaffMember(db: Db, organisationId: string) {
  const [existingUser] = await db.select().from(schema.user).where(eq(schema.user.email, STAFF.email));
  const user =
    existingUser ??
    (await db.insert(schema.user).values({ id: randomUUID(), name: STAFF.name, email: STAFF.email, emailVerified: true }).returning())[0]!;
  const [existingMember] = await db
    .select()
    .from(schema.organisationMembers)
    .where(and(eq(schema.organisationMembers.organisationId, organisationId), eq(schema.organisationMembers.userId, user.id)));
  if (existingMember) return existingMember;
  // No credential row: the staff account gets its one-time password when an
  // owner adds it from the Team screen. The seed never invents a password.
  const [created] = await db
    .insert(schema.organisationMembers)
    .values({ organisationId, userId: user.id, role: "staff", status: "invited", displayName: STAFF.name, title: STAFF.title })
    .returning();
  return created!;
}

/**
 * A portal login for Grays CabLine. The password is a known env value rather
 * than the one-time password `createClientUser` generates, because a developer
 * has to be able to sign in to the portal after a fresh seed. It is its own
 * secret, `SEED_CLIENT_PASSWORD`, and against a production target `main` refuses
 * to run while it is the default or equal to the owner's. A production portal
 * user should come from the admin Portal Users screen and `createClientUser`'s
 * one-time password instead, which is what that path exists for.
 */
export async function seedClientUser(
  db: Db,
  organisationId: string,
  clientId: string,
  clientUser: SeedConfig["clientUser"],
) {
  const [existingUser] = await db.select().from(schema.user).where(eq(schema.user.email, clientUser.email));
  const user =
    existingUser ??
    (await db
      .insert(schema.user)
      .values({ id: randomUUID(), name: clientUser.name, email: clientUser.email, emailVerified: true })
      .returning())[0]!;

  // Any `account` row, not just a credential one — the same rule
  // `ensureOwnerCredential` uses. The narrower "no credential row" test would
  // attach SEED_CLIENT_PASSWORD to a user who exists with only an external
  // provider link, which is somebody's sign-in this seed has no business
  // changing.
  const accounts = await db.select().from(schema.account).where(eq(schema.account.userId, user.id));
  if (accounts.length === 0) {
    await db.insert(schema.account).values({
      id: randomUUID(),
      accountId: user.id,
      providerId: CREDENTIAL_PROVIDER,
      issuer: CREDENTIAL_ISSUER,
      userId: user.id,
      password: await hashPassword(clientUser.password),
    });
  }

  const [existingLink] = await db
    .select()
    .from(schema.clientUsers)
    .where(and(eq(schema.clientUsers.clientId, clientId), eq(schema.clientUsers.userId, user.id)));
  if (!existingLink) {
    await db.insert(schema.clientUsers).values({ organisationId, clientId, userId: user.id, role: "client_admin" });
  }
  return user;
}

/**
 * Returns the invoice this subscription already has for `issuedAt`'s calendar
 * month, otherwise raises one. The calendar month is the natural key: the
 * seed raises at most one invoice per subscription per month, so a re-run
 * finds the existing row instead of allocating a second invoice number.
 *
 * Returns `created` so the closing log line can count what this run actually
 * raised rather than printing a constant.
 */
async function ensureInvoice(db: Db, organisationId: string, subscriptionId: string, issuedAt: Date) {
  const monthStart = new Date(Date.UTC(issuedAt.getUTCFullYear(), issuedAt.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(issuedAt.getUTCFullYear(), issuedAt.getUTCMonth() + 1, 1));
  const [existing] = await db.select().from(schema.invoices).where(and(
    eq(schema.invoices.organisationId, organisationId),
    eq(schema.invoices.subscriptionId, subscriptionId),
    gte(schema.invoices.issuedAt, monthStart),
    lt(schema.invoices.issuedAt, monthEnd),
  ));
  if (existing) return { invoice: existing, created: false };
  const invoice = await createInvoiceFromSubscription(db, organisationId, {
    subscriptionId, issuedAt, vatRatePercent: VAT_RATE_PERCENT, actorKind: "system",
  });
  return { invoice, created: true };
}

/**
 * Billing, ads and reporting demo data. Idempotent like the rest of the seed:
 * every step looks the row up by a natural key before creating anything, so a
 * second `pnpm db:seed` leaves the counts exactly where the first run left them.
 */
async function seedBillingAndAds(
  db: Db,
  organisationId: string,
  clients: { id: string; name: string; email: string }[],
) {
  const [pkg] = await db.select().from(schema.packages)
    .where(and(eq(schema.packages.organisationId, organisationId), eq(schema.packages.active, true)))
    .orderBy(asc(schema.packages.monthlyPricePence))
    .limit(1);
  if (!pkg) throw new Error("seed: no packages found — the package seed step must run before this one");

  const payments = new MockPaymentsAdapter({ vatRatePercent: VAT_RATE_PERCENT });
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  let subscriptionCount = 0;
  let invoiceCount = 0;
  for (const client of clients) {
    await seedBillingProfile(db, organisationId, client.id, client.name);

    const [existing] = await db.select().from(schema.subscriptions).where(and(
      eq(schema.subscriptions.organisationId, organisationId),
      eq(schema.subscriptions.clientId, client.id),
    ));
    const subscription = existing ?? (await createSubscription(
      db,
      organisationId,
      { clientId: client.id, packageId: pkg.id, periodStart, actorKind: "system" },
      payments,
    )).subscription;
    if (!existing) subscriptionCount += 1;

    // Two invoices: last month settled, this month still due.
    const paid = await ensureInvoice(db, organisationId, subscription.id, lastMonth);
    if (paid.created) invoiceCount += 1;
    // Only an invoice that is actually awaiting settlement gets a payment. A
    // `void` invoice was written off deliberately and `reconcileInvoice` leaves
    // it alone, so paying it would insert a payment row that does nothing —
    // and `payments_org_provider_ref` is unique, so the *next* run would abort
    // on a duplicate key and take the ad snapshots and the report down with it.
    if (paid.invoice.status === "draft" || paid.invoice.status === "sent" || paid.invoice.status === "overdue") {
      if (paid.invoice.status === "draft") {
        await markInvoiceSent(db, organisationId, { invoiceId: paid.invoice.id, actorKind: "system" });
      }
      // Look the payment up by the reference this seed writes, in the same
      // look-up-then-insert style as every other step here: a part-settled
      // invoice must not be paid twice, and `recordPayment` does not dedup on
      // `providerRef`.
      const providerRef = `seed-${paid.invoice.number}`;
      const [existingPayment] = await db.select().from(schema.payments).where(and(
        eq(schema.payments.organisationId, organisationId),
        eq(schema.payments.provider, "bank"),
        eq(schema.payments.providerRef, providerRef),
      ));
      if (!existingPayment) {
        await recordPayment(db, organisationId, {
          clientId: client.id, invoiceId: paid.invoice.id, amountPence: paid.invoice.totalPence,
          provider: "bank", providerRef, status: "succeeded", actorKind: "system",
        });
      }
    }

    const due = await ensureInvoice(db, organisationId, subscription.id, periodStart);
    if (due.created) invoiceCount += 1;
    if (due.invoice.status === "draft") {
      await markInvoiceSent(db, organisationId, { invoiceId: due.invoice.id, actorKind: "system" });
    }
  }

  // One ad account for Grays CabLine with 30 days of deterministic metrics,
  // the last 7 of which show the ROAS slide the Sentinel is meant to catch.
  const grays = clients[0]!;
  const [account] = await db.select().from(schema.adAccounts).where(and(
    eq(schema.adAccounts.organisationId, organisationId),
    eq(schema.adAccounts.platform, AD_ACCOUNT.platform),
    eq(schema.adAccounts.externalId, AD_ACCOUNT.externalId),
  ));
  if (!account) await createAdAccount(db, organisationId, { clientId: grays.id, ...AD_ACCOUNT });

  const dropFrom = isoDay(new Date(now.getTime() - ROAS_DROP_DAYS * 86_400_000));
  const ads = new MockAdsAdapter({ dropFrom });

  // The window is anchored to the *report period*, not only to `now`. Seeded
  // late in the month, a plain `now - 30 days` window starts after the report
  // period has ended: `collectAdStats` finds no snapshot inside the period,
  // `stats.ads` comes back null, and the Advertising section — the whole point
  // of Plan 5 — silently vanishes from the demo. So it runs from the earlier of
  // the period start and `now - SNAPSHOT_DAYS` up to yesterday, which keeps the
  // last ROAS_DROP_DAYS fresh for the Sentinel and always covers the period.
  const period = monthPeriod(now);
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const windowStart = new Date(Math.min(period.start.getTime(), now.getTime() - SNAPSHOT_DAYS * 86_400_000));

  let snapshots = 0;
  let snapshotsInPeriod = 0;
  for (let day = new Date(windowStart); day <= yesterday; day = new Date(day.getTime() + 86_400_000)) {
    // Upserts on (ad_account_id, date), so a re-run rewrites the same rows.
    const result = await ingestDailyMetrics(db, organisationId, { date: isoDay(day) }, ads);
    // The same day cut by campaign, so the cost-per-lead screen has both sides
    // of its join locally. Upserts on (account, date, campaign) like the line
    // above, so a re-seed rewrites rather than duplicates.
    await ingestDailyCampaignMetrics(db, organisationId, { date: isoDay(day) }, ads);
    snapshots += result.snapshots;
    if (day >= period.start && day < period.end) snapshotsInPeriod += result.snapshots;
  }
  if (snapshotsInPeriod === 0) {
    throw new Error(
      "seed: no ad snapshots fall inside the report period, so the report would have no Advertising section",
    );
  }

  // One published report for last month so the portal has something to show.
  const report = await buildClientReport(db, organisationId, grays.id, period);
  let reportsPublished = 0;
  if (report.status === "draft") {
    await publishClientReport(db, organisationId, { reportId: report.id, actorId: "seed" });
    reportsPublished = 1;
  }

  // The Sentinel is enabled so the 07:00 cron has something to dispatch.
  await seedAgentEnablement(db, organisationId, SENTINEL_AGENT_KEY);

  return {
    subscriptions: subscriptionCount,
    invoices: invoiceCount,
    snapshots,
    snapshotsInPeriod,
    reports: reportsPublished,
  };
}

/**
 * One published funnel, so `/f/website-enquiry` answers on a freshly seeded
 * database and the Funnels screen is not an empty page.
 *
 * The default six screens, with the contact step at three — the shape the
 * whole feature exists for. Idempotent by slug, so a re-seed never reverts
 * questions that have since been rewritten.
 */
async function seedFunnel(db: Db, organisationId: string) {
  const slug = "website-enquiry";
  const [existing] = await db.select().from(schema.funnels)
    .where(and(eq(schema.funnels.organisationId, organisationId), eq(schema.funnels.slug, slug)));
  if (existing) return existing;

  const created = await createFunnel(db, organisationId, {
    name: "Website enquiry",
    slug,
    headline: "Let us take a look at your website",
    subheadline: "Six quick questions. We will come back to you within one working day.",
    hotScore: 55,
    actorKind: "system",
  });
  return setFunnelStatus(db, organisationId, { funnelId: created.id, status: "published", actorKind: "system" });
}

async function seedMonitor(db: Db, organisationId: string, siteId: string, target: string) {
  const [existing] = await db
    .select()
    .from(schema.monitors)
    .where(and(eq(schema.monitors.organisationId, organisationId), eq(schema.monitors.siteId, siteId), eq(schema.monitors.target, target)));
  if (existing) return existing;
  const [created] = await db.insert(schema.monitors).values({ organisationId, siteId, target }).returning();
  return created!;
}

// Only when run as a script, the same guard `bootstrap.ts` has. Nothing
// imports this module today, but a future test that pulled one helper out of
// it would otherwise seed the developer's database as a side effect of
// collecting the file.
//
// A refused seed must never look like one that ran: name the guard that
// stopped it and exit non-zero.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await main();
  } catch (error) {
    if (error instanceof BootstrapGuardError) {
      console.error(`\ndb:seed refused — guard "${error.guard}"\n${error.message}`);
    } else {
      console.error("\ndb:seed failed", error);
    }
    process.exitCode = 1;
  }
}
