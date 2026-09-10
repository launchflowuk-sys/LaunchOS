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
                  └─ WordPress installed ✅ route confirmed, not yet built
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

## The Hostinger contract, verified 10 Sep

Probed against the live account with permission, using one throwaway subdomain
that was created and then deleted. This is the whole hosting surface — there is
no more of it.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/hosting/v1/websites` | Lists every site. 25 today, one hosting order. |
| `POST` | `/api/hosting/v1/websites` | `{"domain": "...", "order_id": 1007850501}`. Both required. |
| `DELETE` | `/api/hosting/v1/websites/{domain}` | Removes it. |

**Both writes answer `{"message":"Request accepted"}` and are asynchronous.**
The site appeared in the list roughly ten seconds after the POST, and was gone
about fifteen after the DELETE. So a job cannot treat a 200 as "done" — it has
to poll the list until the domain appears or disappears, with a timeout, and a
build that never appears must fail loudly rather than proceed to the next stage
against a docroot that does not exist.

**A subdomain of an owned domain is created as an `addon`, not a `subdomain`.**
`pipeline-test.launchflow.co.uk` came back with `vhost_type: "addon"`,
`parent_domain: null` and its own docroot at
`/home/u509477357/domains/pipeline-test.launchflow.co.uk/public_html`. That is
fine — arguably better, since the review site is fully isolated — but it means
the temp domain is not nested under `launchflow.co.uk` on disk and DNS has to
point at it separately.

### WordPress install — the route, confirmed from Hostinger's own client

Two wrong turns before this landed, both mine. First the endpoint was probed one
segment short and reported as non-existent. Then it was found, POSTed to, and a
`405` was reported as a capability limit. Shoji corrected both: the 405 was a
route mismatch, because `/hosting/v1/wordpress/installations` is the **list**
route and is correctly read-only.

The real operation, read out of `client/client.gen.go` in `hostinger/api-cli`:

```
POST /api/hosting/v1/accounts/{username}/wordpress/installations
operationId: HostingInstallWordPressV1
```

Required body: `credentials`, `domain`, `site-title`.
Optional: `auto-updates` (all|none|minor), `database`, `directory`, `language`,
`overwrite`, `version`.

From the command's own help text, which is the authority on its behaviour:

- The website must exist first — `POST /api/hosting/v1/websites`, then poll
  `GET /api/hosting/v1/websites` until it appears.
- Check `GET /api/hosting/v1/wordpress/installations` filtered by username and
  domain before installing.
- **Asynchronous.** A success only means the job was queued. Installation takes
  roughly 1–2 minutes. Poll the same GET; when the installation appears, it is
  ready.
- With `overwrite` false (the default), installing over an existing WordPress
  makes the async job fail — which is the idempotency guarantee, for free.

Related operations follow the same `/accounts/{username}/websites/{domain}/`
shape: `wordpress/import`, `wordpress/plugins/deploy`, `wordpress/themes/deploy`.

**Nothing is blocked. The whole chain is buildable now.**

Everything else about the hosting API stands: create and delete docroots, both
asynchronous.

**This is the real constraint, and it is worth thinking about before working
around it.** For the *review* stage the generated site is HTML and CSS — it does
not need WordPress to be looked at. Uploading it to the docroot over SFTP is
enough for a client or the team to see it, and it is far less machinery than
scripting a WordPress install.

WordPress only becomes necessary when the client is to edit the site
themselves. That is a step *after* approval, not before it, and it can stay a
person's job until the rest of the chain is proven.

So the honest shape is:

1. Create the review site through the API — one call, then poll.
2. Upload the generated HTML and CSS over SFTP to its docroot.
3. Team checks, Shoji approves, client is told.
4. Install WordPress with `POST /api/hosting/v1/accounts/{username}/wordpress/installations`,
   then poll the installations list for 1–2 minutes until it appears.

Step 2 needs SFTP credentials for the hosting account, which the API does not
expose — they come from the Hostinger panel and belong in the access vault.

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
