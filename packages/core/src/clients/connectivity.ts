import type { Db } from "@launchos/db";
import { schema } from "@launchos/db";
import { and, eq, isNull } from "drizzle-orm";

/**
 * How connected a client actually is, and what is left.
 *
 * Shoji's own words for why this exists: *"when everything is green I know
 * that now it is my job — I can assign teams. When the infrastructure is not
 * complete I am demotivated."* The demotivation is the real bug. Every fact
 * below was already knowable, but only by opening a terminal and reading Graph
 * by hand, so the honest state of a client was invisible and everything felt
 * half-finished at once.
 *
 * Two rules shape the whole thing.
 *
 * **Every check says whose job it is.** `owner` is Shoji, `client` is them,
 * `platform` is a credential nobody has set yet. A list that mixes "ring the
 * plumber" with "assign the Page to the system user" is a list that produces
 * no action, because the next step is different in kind. His clients cannot
 * do technical work — that is the premise — so anything marked `client` has to
 * be a single tap they can be walked through on the phone.
 *
 * **A check nothing depends on is not a gap.** A client on Presence is not
 * missing Instagram; Presence does not post. So the package's `includes`
 * decides which checks apply, and an inapplicable one is reported as such
 * rather than red — otherwise a fully set-up Presence client shows four
 * failures for ever and the panel stops meaning anything.
 */

export type CheckState = "ok" | "missing" | "blocked" | "not_applicable";
export type CheckOwner = "owner" | "client" | "platform";

export interface ConnectivityCheck {
  key: string;
  /** What it is, in the words Shoji would use on the phone. */
  label: string;
  state: CheckState;
  owner: CheckOwner;
  /** What is true now. One line, no hedging. */
  detail: string;
  /** The next action, only when there is one. Written as an instruction. */
  next?: string;
}

export interface ClientConnectivity {
  clientId: string;
  clientName: string;
  packageName: string | null;
  checks: ConnectivityCheck[];
  /** Applicable checks that pass, over applicable checks. `not_applicable` is in neither. */
  ready: number;
  total: number;
  /** True when nothing applicable is missing or blocked — the green Shoji is waiting for. */
  complete: boolean;
  /** When the Meta side was read. Null when it was not read on this pass. */
  socialCheckedAt: Date | null;
}

/** What the social checks need from Meta. Passed in so core stays free of the adapter. */
export interface SocialReality {
  /** Pages the system-user token can act on. Null when Meta is not configured. */
  reachablePageIds: readonly string[] | null;
  /** Page id → Instagram account id, for the Pages we asked about. */
  instagramByPageId: Readonly<Record<string, string | null>>;
  /** Set when the Meta read itself failed, so checks say "could not ask" rather than "not connected". */
  error?: string | undefined;
}

function check(
  key: string,
  label: string,
  owner: CheckOwner,
  state: CheckState,
  detail: string,
  next?: string,
): ConnectivityCheck {
  return { key, label, state, owner, detail, ...(next ? { next } : {}) };
}

/**
 * Reads everything locally knowable, then grades the social side against
 * whatever reality the caller managed to fetch.
 *
 * The local checks are deliberately cheap and always run: a panel that needs
 * Meta to be reachable before it can tell Shoji whether a client has a site
 * would be useless on the day Meta is down.
 */
export async function clientConnectivity(
  db: Db,
  organisationId: string,
  clientId: string,
  social?: SocialReality,
): Promise<ClientConnectivity> {
  const [client] = await db
    .select({
      id: schema.clients.id,
      name: schema.clients.name,
      packageId: schema.clients.packageId,
      email: schema.clients.email,
    })
    .from(schema.clients)
    .where(and(eq(schema.clients.id, clientId), eq(schema.clients.organisationId, organisationId), isNull(schema.clients.deletedAt)));
  if (!client) throw new Error(`client ${clientId} not found in organisation`);

  const [pkg] = client.packageId
    ? await db
        .select({ name: schema.packages.name, includes: schema.packages.includes })
        .from(schema.packages)
        .where(and(eq(schema.packages.id, client.packageId), eq(schema.packages.organisationId, organisationId)))
    : [];

  const includes = pkg?.includes ?? null;
  const wantsSocial = (includes?.socialPostsPerMonth ?? 0) > 0;
  const wantsGbp = (includes?.gbpUpdatesPerMonth ?? 0) > 0;
  const wantsAds = includes?.ads ?? false;

  const [sites, channels, portalUsers, subscriptions, briefs] = await Promise.all([
    db.select({ id: schema.sites.id, name: schema.sites.name, primaryUrl: schema.sites.primaryUrl })
      .from(schema.sites)
      .where(and(eq(schema.sites.organisationId, organisationId), eq(schema.sites.clientId, clientId), isNull(schema.sites.deletedAt))),
    db.select({ channel: schema.contentChannels.channel, externalId: schema.contentChannels.externalId, enabled: schema.contentChannels.enabled })
      .from(schema.contentChannels)
      .where(and(eq(schema.contentChannels.organisationId, organisationId), eq(schema.contentChannels.clientId, clientId), isNull(schema.contentChannels.deletedAt))),
    db.select({ id: schema.clientUsers.id, status: schema.clientUsers.status })
      .from(schema.clientUsers)
      .where(and(eq(schema.clientUsers.organisationId, organisationId), eq(schema.clientUsers.clientId, clientId))),
    db.select({ id: schema.subscriptions.id, status: schema.subscriptions.status })
      .from(schema.subscriptions)
      .where(and(eq(schema.subscriptions.organisationId, organisationId), eq(schema.subscriptions.clientId, clientId), isNull(schema.subscriptions.deletedAt))),
    db.select({ tone: schema.contentBriefs.tone, services: schema.contentBriefs.services })
      .from(schema.contentBriefs)
      .where(and(eq(schema.contentBriefs.organisationId, organisationId), eq(schema.contentBriefs.clientId, clientId), isNull(schema.contentBriefs.deletedAt))),
  ]);

  const monitors = sites.length
    ? await db.select({ id: schema.monitors.id, siteId: schema.monitors.siteId })
        .from(schema.monitors)
        .where(and(eq(schema.monitors.organisationId, organisationId)))
    : [];
  const monitoredSiteIds = new Set(monitors.map((m) => m.siteId));

  const facebook = channels.find((c) => c.channel === "facebook");
  const instagram = channels.find((c) => c.channel === "instagram");
  const checks: ConnectivityCheck[] = [];

  // --- The plan ----------------------------------------------------------
  checks.push(
    pkg
      ? check("package", "On a plan", "owner", "ok", `${pkg.name}.`)
      : check("package", "On a plan", "owner", "missing", "No package on this client.",
          "Set their package — every other check below reads it to know what applies."),
  );

  // --- The website -------------------------------------------------------
  checks.push(
    sites.length > 0
      ? check("site", "Website in LaunchOS", "owner", "ok", `${sites.length === 1 ? sites[0]!.primaryUrl : `${sites.length} sites`}.`)
      : check("site", "Website in LaunchOS", "owner", "missing", "No site recorded.",
          "Websites → add their site with its address. Nothing watches it until you do."),
  );

  if (sites.length > 0) {
    const watched = sites.filter((s) => monitoredSiteIds.has(s.id)).length;
    checks.push(
      watched === sites.length
        ? check("monitor", "Uptime monitored", "owner", "ok", watched === 1 ? "Watched." : `All ${watched} watched.`)
        : check("monitor", "Uptime monitored", "owner", "missing", `${watched} of ${sites.length} watched.`,
            "Add a monitor on the site page. Without it the care plan they pay for is not actually running."),
    );
  }

  // --- The portal --------------------------------------------------------
  const activePortal = portalUsers.filter((u) => u.status === "active").length;
  checks.push(
    activePortal > 0
      ? check("portal", "Can sign in to the portal", "owner", "ok", activePortal === 1 ? "One login." : `${activePortal} logins.`)
      : check("portal", "Can sign in to the portal", "owner", "missing", "No portal login.",
          "Portal users → Invite. Until then they cannot see invoices or approve anything."),
  );

  // --- The money ---------------------------------------------------------
  const activeSub = subscriptions.some((s) => s.status === "active");
  checks.push(
    activeSub
      ? check("billing", "Paying", "owner", "ok", "Active subscription.")
      : check("billing", "Paying", "owner", "missing", subscriptions.length > 0 ? "Subscription is not active." : "No subscription.",
          "Set up their subscription on the billing tab."),
  );

  // --- Content: only where the plan posts ---------------------------------
  if (!wantsSocial) {
    checks.push(check("social", "Social posting", "owner", "not_applicable",
      pkg ? `${pkg.name} does not include posting.` : "No plan set."));
  } else {
    const hasBrief = briefs.some((b) => (b.tone ?? "").trim().length > 0 || (b.services ?? "").trim().length > 0);
    checks.push(
      hasBrief
        ? check("brief", "Content brief filled in", "owner", "ok", "Tone, services and the do-not-say list are set.")
        : check("brief", "Content brief filled in", "owner", "missing", "No content brief.",
            "Content → brief. Everything written for them comes from this, so a thin brief produces thin posts."),
    );

    // Facebook, in three separate facts, because they fail separately and the
    // fix is a different person each time.
    if (!facebook?.externalId) {
      checks.push(check("fb_page", "Facebook Page connected", "client", "missing", "No Page id recorded.",
        "Business Settings → Pages → Add → Request access. They get a notification and tap Approve — they never open Business Suite."));
    } else if (social?.reachablePageIds === null) {
      checks.push(check("fb_page", "Facebook Page connected", "platform", "blocked", "Meta is not configured, so this cannot be checked.",
        "Set META_ADS_ACCESS_TOKEN and META_ADS_APP_SECRET."));
    } else if (social?.error) {
      checks.push(check("fb_page", "Facebook Page connected", "platform", "blocked", `Could not ask Meta: ${social.error}`,
        "Try again. The Page id is recorded, so this is our end, not theirs."));
    } else if (!social) {
      checks.push(check("fb_page", "Facebook Page reachable", "owner", "missing", `Page ${facebook.externalId} recorded; Meta not checked on this pass.`,
        "Press Re-check to ask Meta whether the token can actually use it."));
    } else if (social.reachablePageIds.includes(facebook.externalId)) {
      checks.push(check("fb_page", "Facebook Page connected", "owner", "ok", "The token can post to it."));
    } else {
      checks.push(check("fb_page", "Facebook Page connected", "owner", "missing",
        "The Page id is recorded but the token cannot use it.",
        "Business Settings → Users → System Users → launchos → Add Assets → tick this Page. Being in the portfolio is not enough — this is the step that gets missed."));
    }

    // Instagram, which depends on the Page above being reachable.
    const pageReachable = Boolean(facebook?.externalId && social?.reachablePageIds?.includes(facebook.externalId));
    const igOnPage = facebook?.externalId ? social?.instagramByPageId[facebook.externalId] ?? null : null;
    if (!facebook?.externalId) {
      checks.push(check("ig", "Instagram connected", "client", "missing", "Waiting on the Facebook Page first.",
        "Instagram is reached through the Page, so the Page has to come first."));
    } else if (!social || !pageReachable) {
      checks.push(check("ig", "Instagram connected", "owner", "missing", "Cannot be checked until the Page is reachable.",
        "Fix the Page above, then re-check."));
    } else if (igOnPage) {
      checks.push(
        instagram?.externalId
          ? check("ig", "Instagram connected", "owner", "ok", "Linked to the Page and recorded here.")
          : check("ig", "Instagram connected", "owner", "missing", "Linked to the Page but not recorded in LaunchOS.",
              "Add an Instagram channel row for this client. The id is read off the Page, so there is nothing to type."),
      );
    } else {
      checks.push(check("ig", "Instagram connected", "client", "missing", "No Instagram account is linked to their Page.",
        "Their Instagram must be a Business or Creator account and linked to the Page. No API can post to a personal account — Meta's rule, no workaround."));
    }
  }

  // --- Google Business Profile -------------------------------------------
  if (!wantsGbp) {
    checks.push(check("gbp", "Google Business Profile", "owner", "not_applicable",
      pkg ? `${pkg.name} does not include Google updates.` : "No plan set."));
  } else {
    const gbp = channels.find((c) => c.channel === "gbp");
    checks.push(
      gbp?.externalId
        ? check("gbp", "Google Business Profile", "owner", "ok", "Recorded.")
        : check("gbp", "Google Business Profile", "client", "missing", "Not connected.",
            "Request Manager access on their Business Profile — never Owner. They approve it from an email."),
    );
  }

  // --- Ads ---------------------------------------------------------------
  if (!wantsAds) {
    checks.push(check("ads", "Advertising", "owner", "not_applicable",
      pkg ? `${pkg.name} does not include ads.` : "No plan set."));
  } else {
    checks.push(check("ads", "Advertising", "owner", "missing", "Ads run from LaunchFlow's own ad account.",
      "They do not need an ad account. Agree a daily budget and confirm the conversion fires before enabling anything."));
  }

  const applicable = checks.filter((c) => c.state !== "not_applicable");
  const ready = applicable.filter((c) => c.state === "ok").length;

  return {
    clientId: client.id,
    clientName: client.name,
    packageName: pkg?.name ?? null,
    checks,
    ready,
    total: applicable.length,
    complete: applicable.every((c) => c.state === "ok"),
    socialCheckedAt: social ? new Date() : null,
  };
}
