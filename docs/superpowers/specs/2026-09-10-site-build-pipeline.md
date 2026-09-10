# The site build pipeline — 10 Sep 2026

Shoji's ask, in his words: automate from where the website is built through to
hosting, WordPress installed, deployed, the team notified to check and approve,
and only then the customer told.

This is the design, what is built, and the one thing that genuinely blocks the
rest.

---

## The chain

```
lead (wizard)
  └─ qualification answers          ✅ built
      └─ brief                      ✅ built  briefFromLead
          └─ generated site         ✅ built  SiteGeneratorAdapter (mock-first)
              └─ hosting provisioned    ⚠️ feasible on Hostinger (POST supported), not built
                  └─ WordPress installed ⚠️ install path not yet confirmed
                      └─ deployed to a staging URL
                          └─ team checks
                              └─ Shoji approves      ← the gate
                                  └─ client notified
```

## What is built

**The lead's answers reach the model without a person in the middle.** The
wizard writes `leads.qualification`; `briefFromLead` reads it and produces a
`SiteBrief`. It refuses when the lead is too thin — a name with no services is
three paragraphs of invention on somebody's real business — and names what is
missing.

**Generation is mock-first.** `SiteGeneratorAdapter` has a mock that builds from
the real brief (not lorem ipsum, so a field that never arrived shows up in a
test) and an OpenAI implementation that goes live when **both**
`OPENAI_API_KEY` and `OPENAI_MODEL` are set. There is no default model id on
purpose: a guess either 404s or silently runs something cheaper than intended.

## Correction, 10 Sep

An earlier version of this document said provisioning was blocked. That was
wrong, and wrong in an avoidable way: it checked Coolify, found the adapter
read-only, and reported that as the whole picture. Shoji builds WordPress on
**Hostinger Business hosting**, which was never looked at.

It should have been. Probed against his own account:

```
GET     /api/hosting/v1/websites   200 — 25 sites, with vhost_type, website_type,
                                        root_directory, username
OPTIONS /api/hosting/v1/websites   allow: GET, HEAD, POST
```

**POST is supported.** Hostinger can create a website from the API, the per-site
route accepts DELETE for teardown, and the account already holds
`HOSTINGER_API_TOKEN` — the same token the registrar and cost sync use. Existing
sites include subdomains (`support.launchflow.co.uk`, `engine.launchflow.co.uk`),
which is exactly the shape a temp review domain needs.

So the pipeline is buildable on Hostinger today. Coolify remains an option and
neither is binding.

**Not yet verified:** that WordPress *installation* is exposed as its own
operation, and what the POST body requires. Both need reading against the live
API before anything is written — and no write has been attempted, because
creating a website on live hosting is not something to discover by trying.

## What was blocking it on Coolify only

**The Coolify adapter is read-only.** It has `getResources`, `restart` and
`listApplications`. It cannot create an application, attach a domain, or install
anything. Provisioning is therefore not "wire up the existing integration" — it
is new API surface against Coolify's REST API, and it is the real work in this
chain.

What it needs, roughly in order:

1. `createApplication` — a WordPress service on the Hetzner box, from Coolify's
   service templates.
2. A generated database and credentials per site, held in the access vault
   rather than in a job's memory.
3. A staging hostname per build (`something.staging.launchflow.co.uk`), which
   also needs a wildcard DNS record — the Cloudflare adapter can already write
   records, so this part is close.
4. Pushing the generated pages into WordPress. The CMS adapter already talks to
   WordPress for content changes, so this is the least novel step.
5. Deleting it all again when a build is abandoned, which is the step everybody
   forgets and the one that fills a disk.

Step 1 is where the risk sits: creating and destroying real infrastructure from
a job, on the box that also runs every client's live site.

## Where the gate goes, and why

**Deploy to staging happens before approval. Nothing reaches the client's real
domain, and the client hears nothing, until Shoji has said yes.**

A generated site landing on a client's live domain unreviewed is the one step in
this chain that cannot be walked back — the client has already seen it, and so
has Google. So the order is: generate, provision, deploy to a **staging URL**,
team checks it, Shoji approves, then the client is told.

That fits what already exists rather than inventing a second mechanism: the
approvals queue is where every outward action in this product waits, and
`client_review` already exists as a non-blocking way to show a client a design.

## Suggested order when this is picked up

1. Read the Hostinger hosting API properly: what `POST /hosting/v1/websites`
   requires, and whether WordPress installation is its own call or a field on
   creation. Then a `HostingProvisioner` interface with a mock, as rule 4 wants,
   and Hostinger behind it — Coolify can be a second implementation later
   without changing anything above it.
2. A `site_builds` table carrying the stage, the staging URL and the approval.
3. The worker job driving the stages, one at a time, resumable — a build that
   dies halfway must not leave an orphaned WordPress instance on the box.
4. The screen: what is building, what is waiting on a check, what is live.

## Notes worth keeping

- **Disk.** Every build is a container and an image. The box hit 84% twice in
  one day from ordinary deploys; a pipeline that creates a WordPress instance
  per lead needs its cleanup written at the same time as its creation, not
  after.
- **The client is told once, by a person's decision.** Not by a job, and not
  twice.
