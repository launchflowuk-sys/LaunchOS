import type { KnowledgeAudience } from "@launchos/db/schema";

/**
 * A guide for every screen in the app.
 *
 * The point is coverage, not polish. Shoji's ask was that an employee should be
 * able to do the job without asking him again — and neither of us can predict
 * where a particular person gets stuck, so the target is not the hard bits, it
 * is all of it. Thirty-nine screens, thirty-nine guides, and a gaps list that
 * reads zero.
 *
 * Written for somebody who is not confident with software: short numbered
 * steps, the button named as it appears, and no jargon that the screen does not
 * use itself. Every one is grounded in what its screen actually says it does,
 * not in what a screen of that name usually does — a guide that is confidently
 * wrong is worse than a missing one, because somebody will follow it.
 *
 * They arrive as **drafts**. Shoji publishes them, which is what he asked for
 * and is right: these describe the software accurately but not his habits, and
 * a guide is the one kind of writing where being nearly right is a problem.
 */

export interface StarterGuide {
  slug: string;
  title: string;
  /** The screen it appears on, as a nav href. */
  route: string;
  audiences: readonly KnowledgeAudience[];
  body: string;
}

/** Staff first — they are who this is for. Admin too, so the owner sees the same words. */
const BOTH: readonly KnowledgeAudience[] = ["staff", "admin"];

export const STARTER_GUIDES: readonly StarterGuide[] = [
  {
    slug: "using-the-dashboard",
    title: "What to do first each morning",
    route: "/",
    audiences: BOTH,
    body: `The dashboard shows what needs attention right now. Work down it.

1. Anything red or marked **Needs you** comes first — it is waiting on a person.
2. Check **Approvals** next. Nothing an agent wants to send leaves until somebody decides.
3. Then your own tasks.

If the top of the screen says the background worker is not running, tell Shoji. While it is down, emails, agent runs and publishing are all paused.`,
  },
  {
    slug: "reading-the-activity-feed",
    title: "Finding out what happened",
    route: "/activity",
    audiences: BOTH,
    body: `Everything that has happened, grouped by the part of the business it belongs to.

1. Pick a client from **Client** and press **Show** to see only theirs.
2. **Needs attention** at the top counts failures and warnings in what you are looking at. If it is not zero, start there.
3. Each group — Support, Money, Delivery, Automation — has a coloured dot so you can find the one you want without reading everything.

Use this when somebody asks "what happened with X". Press **Clear** to go back to everyone.`,
  },
  {
    slug: "adding-a-new-client",
    title: "Adding a new client",
    route: "/clients",
    audiences: BOTH,
    body: `1. Press **New client** at the top right.
2. Enter their business name. Everything else can be filled in later.
3. Press **Create**.

A support email address is made for them automatically — you do not set one up.

To find someone, type into **Search**. To see only certain clients, choose a **Status** and press **Apply**.

Opening a client shows their websites, domains, billing and support history in tabs.`,
  },
  {
    slug: "turning-a-lead-into-a-client",
    title: "Handling a new enquiry",
    route: "/leads",
    audiences: BOTH,
    body: `Leads come from the website form, the start-a-project wizard, self-serve sign-ups, and anyone you add by hand.

1. Open the lead and read what they sent. Someone who used the wizard will have answered questions about their business — that is what the brief is built from.
2. Reply, or wait for the drafted reply in **Approvals** if an agent wrote one.
3. When they say yes, use **Convert** to make them a client. Nothing is lost — the enquiry stays attached.

A lead that goes nowhere can be marked lost. It stays on record.`,
  },
  {
    slug: "after-a-discovery-call",
    title: "After a discovery call",
    route: "/meetings",
    audiences: BOTH,
    body: `Calls booked through the booking page appear here, on Zoom.

1. Open the meeting once it has happened.
2. Mark how it went. This is what sends the follow-up — if you skip it, nothing goes out.
3. Add a note if anything was agreed that is not written down anywhere else.

If a meeting did not happen, say so rather than leaving it. The follow-up wording is different.`,
  },
  {
    slug: "what-funnels-are-for",
    title: "What the funnels do",
    route: "/funnels",
    audiences: BOTH,
    body: `A funnel is five or six questions on a phone. The name and number are asked in the middle on purpose, so somebody who gives up early has still told us who they are.

1. To make one, fill in **Name**, leave **Web address** blank unless you want a specific one, choose a client, and press **Create funnel**.
2. The page lives at /f/ plus the web address.
3. Answers arrive as leads.

Leave the client blank if the funnel is ours rather than a client's.`,
  },
  {
    slug: "sending-a-proposal",
    title: "Sending a proposal",
    route: "/proposals",
    audiences: BOTH,
    body: `A proposal is a priced offer to a lead or client.

1. Create it, add the lines, and check the total.
2. Send it. It goes for approval first — sending is an outward action and waits for a person.
3. The client accepts it by clicking, on their own copy.

**A proposal is frozen once it goes out.** To change anything, write a new one. Do not try to edit a sent proposal.`,
  },
  {
    slug: "running-a-project",
    title: "Keeping a build on track",
    route: "/projects",
    audiences: BOTH,
    body: `A project gives the client one honest progress page and gives us one place to see the work.

1. Open the project to see its phases and milestones.
2. Move a milestone when it is genuinely done — the client sees this.
3. Add a target date if there is one. An empty date is better than a wrong one.

When the build is finished, the handover is sent from here, and the client signs it off. That is what starts their care plan.`,
  },
  {
    slug: "looking-after-a-website",
    title: "Checking a website",
    route: "/websites",
    audiences: BOTH,
    body: `Every site we build, host or look after.

1. Open a site to see who it belongs to, where it is hosted, and whether it is up.
2. If a site is down, an incident is usually raised for you — check **Incidents** before raising anything by hand.
3. The hosting reference links it to the server. Do not change it unless you moved the site.`,
  },
  {
    slug: "domains-and-renewals",
    title: "Domains and when they expire",
    route: "/domains",
    audiences: BOTH,
    body: `Every domain bought for or assigned to a client.

1. The renewal date comes from the registrar automatically. If one is blank, the registrar did not tell us.
2. A domain close to expiry is flagged. Renewing is done at the registrar, not here.
3. Assign a domain to the right client so its cost lands on the right margin.

Never let a client's domain lapse. It is the hardest thing on this list to undo.`,
  },
  {
    slug: "working-through-tasks",
    title: "Working through your tasks",
    route: "/tasks",
    audiences: BOTH,
    body: `Onboarding, recurring service work and support tasks across every client.

1. Filter to yourself to see your own.
2. Move a task to **In progress** when you start, and **Done** when it is finished.
3. If you are blocked, mark it blocked and say why — an unexplained blocked task stops everything behind it.

Recurring tasks are generated from the client's package. If one looks wrong, the package is where to fix it.`,
  },
  {
    slug: "content-month-to-month",
    title: "How the monthly content works",
    route: "/content",
    audiences: BOTH,
    body: `Social posts, blog posts and Google Business updates, planned a month at a time.

1. The month is laid out automatically from what the client's package includes.
2. Posts are only planned for platforms the client has actually connected. If a client is paying for posts and has nothing connected, you will be told.
3. Written posts go to **Approvals**. Nothing publishes until somebody approves it.

To connect a client's Facebook or Instagram, open the client and use their Content tab.`,
  },
  {
    slug: "publishing-a-case-study",
    title: "Putting work in the portfolio",
    route: "/case-studies",
    audiences: BOTH,
    body: `This is the public portfolio — what is published here is what launchflow.co.uk shows, in this order.

1. Check the wording carefully. It is public the moment it is published.
2. Reorder them by changing their order here; the website follows.
3. Unpublish rather than delete if you are unsure.

Never publish a client's work without checking they are happy for it to be shown.`,
  },
  {
    slug: "answering-the-inbox",
    title: "Replying to a client",
    route: "/inbox",
    audiences: BOTH,
    body: `Every client conversation, newest first.

1. Open the thread and read the whole thing before replying — the client may have answered themselves.
2. Write the reply and send. It goes from the client's own support address.
3. If an agent drafted a reply, it is in **Approvals** instead, waiting for you to read it.

If you do not know the answer, say so and say when you will know. That is better than silence.`,
  },
  {
    slug: "handling-a-support-case",
    title: "Handling a support case",
    route: "/cases",
    audiences: BOTH,
    body: `Support work raised by clients, by monitors, and by agents.

1. Open the case and check who raised it. A monitor-raised case means something broke on its own.
2. Assign it to yourself so nobody duplicates the work.
3. Update the status as you go. The client sees the case in their portal.

There is a promised first-response time. A case still unanswered past it will ring the owner.`,
  },
  {
    slug: "when-a-site-goes-down",
    title: "When a site goes down",
    route: "/incidents",
    audiences: BOTH,
    body: `Uptime and hosting incidents across every client site.

1. An incident is opened automatically when a site stops responding. You do not need to raise one.
2. Open it to see what was checked and when.
3. Once the site is back, resolve the incident and write one line about what it was.

If several sites go down at once it is usually the server, not the sites. Tell Shoji before working through them one by one.`,
  },
  {
    slug: "recording-a-payment",
    title: "Recording a payment",
    route: "/payments",
    audiences: BOTH,
    body: `Every payment recorded against a client, from Stripe or entered by hand.

1. Stripe payments appear on their own. You do not add those.
2. For a bank transfer, add the payment by hand against the right client, with the date it landed.
3. Attach it to the invoice it pays, if there is one. That is what stops the invoice being chased.

The figures on the Clients screen are built from this. A payment recorded against the wrong client makes two numbers wrong.`,
  },
  {
    slug: "raising-and-sending-an-invoice",
    title: "Raising and sending an invoice",
    route: "/invoices",
    audiences: BOTH,
    body: `Every invoice raised for a client, and where it has got to.

1. Most invoices are raised automatically, ahead of the client's payment date, and appear here as drafts.
2. Sending one is an outward action, so it waits in **Approvals** for a decision.
3. Once paid, mark it paid — or record the payment, which does the same thing.

The invoice shows the client what each line is for and how to pay by transfer. If the bank details look wrong, they are set in Settings.`,
  },
  {
    slug: "checking-ad-accounts",
    title: "Checking how the ads are doing",
    route: "/ads",
    audiences: BOTH,
    body: `Google and Meta accounts, with the last week against the one before.

1. A big drop week on week is worth looking at before the client notices.
2. Open an account to see the campaigns underneath.
3. Spend here is what the client is charged for — check it matches what they agreed.`,
  },
  {
    slug: "approving-an-ad-report",
    title: "Approving an ad report",
    route: "/ads/reports",
    audiences: BOTH,
    body: `These are drafted by the Ad Performance Sentinel.

1. Read the report as if you were the client. Does it explain what happened, or just list numbers?
2. Approve it before it can be emailed. It will not go out otherwise.
3. If the wording is wrong, reject it and say why — that is on the record.`,
  },
  {
    slug: "publishing-a-monthly-report",
    title: "Publishing a client's monthly report",
    route: "/reports",
    audiences: BOTH,
    body: `Monthly client reports, built from what actually happened.

1. Reports are prepared automatically a few days before the client's payment date.
2. Read it, then publish to make it visible in the client's portal.
3. Sending it by email waits in **Approvals**.

A report with nothing in it is worth a conversation, not a send.`,
  },
  {
    slug: "assigning-supplier-costs",
    title: "Assigning what we pay to a client",
    route: "/settings/costs",
    audiences: BOTH,
    body: `What we pay suppliers, and which client each one is for.

1. Domain subscriptions are matched to their domain automatically, by when they were bought.
2. Anything left under **Not assigned** needs a person. Choose the client and press **Save**.
3. **Trials that will charge** is the section with a deadline — those become bills unless cancelled at the supplier.

A cost assigned to the wrong client makes that client look less profitable than they are. If you are not sure, leave it.`,
  },
  {
    slug: "deciding-an-approval",
    title: "Approving or rejecting",
    route: "/approvals",
    audiences: BOTH,
    body: `Everything an agent or a person wants to send outwards waits here.

1. Each card says exactly what will happen — the client, the address, the wording.
2. **Approve** does it. **Reject** does not, and sends the item back.
3. Add a note when you reject. It is the only record of why.

Rejected cards can be cleared once you are done with them. Approved ones stay, because they are the record of what an agent was allowed to do.`,
  },
  {
    slug: "reading-the-morning-brief",
    title: "Reading the morning brief",
    route: "/briefs",
    audiences: BOTH,
    body: `The Ops Brief agent reads yesterday and the open state at 07:00 and writes what needs you.

1. Read it first thing. It is meant to replace going through five screens.
2. Anything it links to is worth opening.
3. Re-running today replaces today's brief — it does not add a second one.`,
  },
  {
    slug: "checking-what-the-agents-did",
    title: "Checking what an agent did",
    route: "/agents/runs",
    audiences: BOTH,
    body: `Every run the system recorded, newest first.

1. **What happened** is the column that matters — it says what the run produced.
2. **Failed** means it stopped with an error. **Skipped** means the agent is not switched on for us.
3. Open a run to see every step it took, in order.

If something you expected did not happen, look here before assuming it is broken.`,
  },
  {
    slug: "switching-an-agent-on-or-off",
    title: "Switching an agent on or off",
    route: "/settings/agents",
    audiences: ["admin"],
    body: `Which autonomous agents run for this organisation.

1. Every agent in this build is listed, whether it is on or not.
2. A tool marked **Needs approval** never acts on its own — it queues a card for a person.
3. Switching an agent off stops it entirely. Runs against it are recorded as skipped, so nothing disappears silently.`,
  },
  {
    slug: "email-routing-and-testing",
    title: "Checking that email is working",
    route: "/settings/email",
    audiences: ["admin"],
    body: `Inbound support routing and the outbound email adapter.

1. The figures at the top say whether mail is moving. **Failed** and **Stuck in the queue** are the two that need action.
2. **Clients routed** shows how many active clients have a support address. Any without one cannot receive support email.
3. **Send test email to owner** proves outbound works. It now tells you what went wrong if it fails.

If mail is stuck, check the background worker is running before changing any settings.`,
  },
  {
    slug: "issuing-an-api-token",
    title: "Issuing an API token",
    route: "/settings/api-tokens",
    audiences: ["admin"],
    body: `Keys for things outside LaunchOS that need to read it.

1. Give the token a name that says what it is for.
2. Tick only the areas it needs. A token starts able to read nothing.
3. Copy the token when it is shown. It is not shown again.

Revoke a token the moment it is no longer needed, or if it may have been seen by anyone else.`,
  },
  {
    slug: "writing-a-knowledge-article",
    title: "Writing a guide",
    route: "/knowledge",
    audiences: BOTH,
    body: `What Support Triage reads before drafting a reply, and what the team reads before fixing the same thing twice.

1. Press **New article**.
2. Choose **who it is for** — staff, the owner, or clients.
3. Tick every screen it helps with. The help button on those screens will show it.
4. Write it as steps somebody can follow without asking.
5. Tick **Published**. Drafts are never shown to anybody.

**Help coverage** shows which screens still have nothing written.`,
  },
  {
    slug: "restoring-an-archived-client",
    title: "Bringing back an archived client",
    route: "/clients/archive",
    audiences: BOTH,
    body: `Archived clients keep everything — invoices, sites, history.

1. Find the client here.
2. Press **Restore** to put them back on the active list.

Archiving is how a client leaves. Deleting is different and is blocked when there is money attached, because those records have to be kept.`,
  },
  {
    slug: "adding-a-team-member",
    title: "Adding someone to the team",
    route: "/team",
    audiences: ["admin"],
    body: `People who can sign in and be assigned work. Sign-up is disabled — accounts are created here.

1. Press to add a member and enter their name and email.
2. Choose what they may reach. Give the least that lets them do the job.
3. They get an invitation email with a one-time password.

If the invitation does not arrive, check Settings → Email before sending it again.`,
  },
  {
    slug: "reading-team-health",
    title: "Seeing how the team is doing",
    route: "/team/health",
    audiences: ["admin"],
    body: `Cases, response times, overdue work and hours over the last couple of weeks.

1. Overdue work and slow first responses are the two worth acting on.
2. Hours come from the clock, so they are only as good as people remembering to use it.
3. A quiet week for one person is worth a conversation, not a conclusion.`,
  },
  {
    slug: "using-the-clock",
    title: "Clocking in and out",
    route: "/team/timesheets",
    audiences: BOTH,
    body: `Every entry that started this week: when, for how long, and against what.

1. When you sign in you are asked to start your shift. One press.
2. The clock in the top bar shows it running, and stops it when you are done.
3. You can start a timer against a specific task from that task instead.

If you forget to stop the clock, tell whoever manages the timesheets rather than leaving a twelve-hour entry.`,
  },
  {
    slug: "your-own-activity",
    title: "What your activity shows",
    route: "/team/activity",
    audiences: BOTH,
    body: `Which screens you have worked from, counted per screen per day — not per click.

1. You see your own. Your manager sees the same thing.
2. It records the screen, not what you looked at on it. Opening a client shows as Clients, not which client.
3. It is here so hours have a "what for" beside them.

Nothing here is hidden from you. If a number looks wrong, say so.`,
  },
  {
    slug: "organisation-settings",
    title: "Company details and bank details",
    route: "/settings/organisation",
    audiences: ["admin"],
    body: `Who this LaunchOS runs for, and where client mail lands.

1. The legal name, address, VAT and company number all appear on invoices.
2. **Bank account name, sort code and account number** are printed on every invoice as how to pay. They only appear when the name and a full account are filled in.
3. The invoice footer is free text under the bank details — terms, or a thank-you.

Leaving VAT blank means invoices are raised zero-rated. Do not put a VAT number here unless the business is registered.`,
  },
  {
    slug: "billing-adapters",
    title: "Which payment services are connected",
    route: "/settings/billing",
    audiences: ["admin"],
    body: `Which payment and ads adapters this deployment is using.

1. This is a read of the configuration, not a place to change it. Adapters are set by environment variables on the server.
2. Anything showing as a mock is not doing anything real.
3. If something says mock that you expect to be live, the setting is missing on the server.`,
  },
  {
    slug: "editing-a-package",
    title: "Changing what a package includes",
    route: "/settings/packages",
    audiences: ["admin"],
    body: `What each retainer includes.

1. The quantities here drive what gets generated each month — posts, blogs, Google updates, and the recurring tasks that go with them.
2. Changing a package changes it for every client on it.
3. Change the price here and existing subscriptions keep theirs until they are changed.

If one client needs something different, give them their own billing lines rather than editing the package everyone shares.`,
  },
  {
    slug: "editing-task-templates",
    title: "Changing the standard tasks",
    route: "/settings/task-templates",
    audiences: ["admin"],
    body: `The blueprints that onboarding and recurring generation turn into tasks.

1. A template becomes a real task when a client is onboarded, or each month for recurring work.
2. Reorder them by editing the sort order.
3. Changing a template does not change tasks that already exist.

Deleting a template leaves tasks made from it alone — they are not removed.`,
  },
  {
    slug: "exporting-data",
    title: "Getting the data out",
    route: "/settings/export",
    audiences: ["admin"],
    body: `Download any module as a CSV.

1. Choose the module and download.
2. Money is exported in pounds, dates in ISO format — so a spreadsheet reads them correctly.
3. Exports contain client data. Do not email one, and delete it when you are done with it.`,
  },
];
