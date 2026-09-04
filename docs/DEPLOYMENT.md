# Deployment

## Local

```bash
cp .env.example .env      # fill BETTER_AUTH_SECRET, ANTHROPIC_API_KEY
pnpm install
pnpm db:up                # postgres:17 on localhost:5432
pnpm db:migrate
pnpm db:seed
pnpm dev                  # web
pnpm dev:worker           # worker
```

Tests: `pnpm test` needs the docker Postgres running. Integration tests run against `DATABASE_URL_TEST` if set, otherwise `DATABASE_URL` — no separate test database is created. Each test runs inside a transaction that is always rolled back, and test data uses unique slugs (for example `test-${crypto.randomUUID()}` for `organisations.slug`), so it never collides with the seeded data.

## Production (Coolify on Hetzner)

Three Coolify resources in one project, all on the same internal network:

1. **postgres** — Coolify managed PostgreSQL 17 with a persistent volume and daily backups to Hetzner storage box. Not exposed publicly.
2. **web** — Docker build from `infra/Dockerfile.web`. Domain `os.launchflow.co.uk` (or chosen). Health check `GET /api/health`.
3. **worker** — Docker build from `infra/Dockerfile.worker`. No public port. Health check is the process itself.

Both app resources auto-deploy from `main` on GitHub push. Migrations run as the web container's entrypoint (`pnpm db:migrate && next start`) so the schema is always applied before serving. The worker waits for the web health check before starting.

Environment variables are set in Coolify, never committed. `NODE_ENV=production`, `APP_URL`, `BETTER_AUTH_URL` and `DATABASE_URL` point at the internal Postgres hostname.

## Coolify setup (to run after first push)

Do not push to GitHub until Shoji approves the local run. Once approved and `main` is pushed, set up Coolify as follows.

1. **Project** — create a new Coolify project named `LaunchOS`.

2. **Postgres resource** — in the `LaunchOS` project, add a new resource → Database → PostgreSQL, version `17`. Give it a persistent volume and enable daily backups to the Hetzner storage box. Do not expose it publicly (no domain, no public port mapping). Note the internal hostname/port Coolify assigns (used as the `DATABASE_URL` host for the app resources below).

3. **Web resource (Docker build)**
   - New resource → Docker (build from Dockerfile) → connect the GitHub repo, branch `main`.
   - Dockerfile path: `infra/Dockerfile.web`
   - Build context: `/` (repo root)
   - Port: `3000`
   - Domain: `os.launchflow.co.uk` (or the chosen domain) — enable HTTPS/Let's Encrypt.
   - Health check path: `/api/health`
   - Auto-deploy: enable "auto deploy on push" for `main`.
   - Env vars (set in Coolify's environment variables UI, never committed — same keys as `.env.example`):
     - `NODE_ENV=production`
     - `DATABASE_URL` → internal Postgres connection string from step 2 (`postgres://<user>:<pass>@<internal-host>:5432/<db>`)
     - `APP_URL` → `https://os.launchflow.co.uk` (match the domain above)
     - `BETTER_AUTH_SECRET` → generate with `openssl rand -base64 32`
     - `BETTER_AUTH_URL` → same as `APP_URL`
     - `ANTHROPIC_API_KEY`
     - `AGENT_MODEL` → `claude-opus-5`
     - `SUPPORT_EMAIL_DOMAIN` → the domain every client support address is minted under (`<client-slug>@<domain>`), e.g. `support.launchflow.co.uk`. Its MX records must point at the inbound mail provider. Unset falls back to `support.launchflow.co.uk` in the app; the reconcile script refuses to run on that fallback unless you pass `--allow-default-domain`, because a mass rewrite onto a domain you do not own is the failure it exists to repair. Changing it later does **not** rewrite addresses already stored on existing clients, and migration `0007_backfill_support_email.sql` fills older rows in with the fallback domain because a migration cannot read env — so **after setting or changing this, run the reconcile script** (see step 6). Inbound routing matches on `email_identities.address` alone, so a client left on the wrong domain silently never receives mail.
     - `OWNER_NOTIFY_EMAIL` → optional. In-app notifications always reach the owner's bell; set this to also email them. Leave unset to keep notifications in-app only.
     - `INBOUND_EMAIL_PROVIDER` → `postmark`, `cloudflare` or `generic`; the payload shape the webhook expects when the URL carries no `?provider=`.
     - `EMAIL_ADAPTER` → `mock` until the DNS records verify, then `smtp`.
     - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` — required once `EMAIL_ADAPTER=smtp`.
     - `INBOUND_EMAIL_SECRET` → the shared secret the inbound provider sends back in `x-launchos-inbound-secret`.
     - `STORAGE_DIR` → where inbound attachments are written; must be a persistent volume (see **Inbound email** below).
     - `COOLIFY_API_URL`, `COOLIFY_API_TOKEN`
     - `CLOUDFLARE_API_TOKEN`
     - `GOOGLE_ADS_DEVELOPER_TOKEN`
     - `META_ADS_ACCESS_TOKEN`
     - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
     - `UPTIME_PROBE=http` (mock is for local/test only)
     - `LLM=anthropic` (fake is for local/test only)
     - `AGENT_POLICY=safe`

4. **Worker resource (Docker build)**
   - New resource → Docker (build from Dockerfile) → same GitHub repo, branch `main`.
   - Dockerfile path: `infra/Dockerfile.worker`
   - Build context: `/` (repo root)
   - No domain, no public port.
   - Health check: process-based (no HTTP endpoint); configure Coolify's restart policy to restart on exit.
   - Auto-deploy: enable "auto deploy on push" for `main`.
   - Deploy after the web resource so migrations have already run once; set it to start after the web resource's health check passes.
   - Env vars: `DATABASE_URL` (same as web), `APP_URL`, `ANTHROPIC_API_KEY`, `AGENT_MODEL`, `LLM=anthropic`, `AGENT_POLICY=safe`, `UPTIME_PROBE=http`, plus `EMAIL_ADAPTER`, `SMTP_*`, `MAIL_FROM` and `STORAGE_DIR`. The worker is what actually sends outbound mail and reads inbound attachments, so leaving these off the worker means replies queue and never leave.
   - Keep the worker at a **single replica**. The monitor sweep is not safe to run concurrently: two workers would double-count consecutive failures and open duplicate incidents.

5. **First owner account** — sign-up is disabled in the app (`emailAndPassword.disableSignUp`), so the first account has to be written directly. Run the **bootstrap**, once, inside the running web container:

   ```bash
   docker exec <web-container> pnpm db:bootstrap
   ```

   It creates exactly two things: the organisation, from `SEED_ORG_NAME` and `SEED_ORG_SLUG` (defaults `LaunchFlow` / `launchflow`), and the owner user and its credential, from `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD`, with an owner membership joining them. Nothing else. Set `SEED_OWNER_PASSWORD` in the web resource's environment variables before running it, then **remove that variable and redeploy** once you have signed in. It is idempotent, and re-running it never changes an existing password — to rotate one, sign in and change it.

   Four guards run before anything is written. Each refusal prints the guard's name and the reason, and exits non-zero — a bootstrap that did not do what you asked never looks like one that did:

   - **`password-floor`** (every environment) — `SEED_OWNER_PASSWORD` must be at least 12 characters, the same floor the app enforces on every staff and client account. Better Auth only re-checks a password on sign-up, change and reset, none of which this account will go through, so this is the only place the floor can be applied to it.
   - **`organisation-slug`** (every environment) — `SEED_ORG_SLUG` must be 2–63 characters of lowercase letters, digits and hyphens. Leaving the variable unset uses `launchflow`; setting it to an empty value is a refusal, because an empty slug satisfies `not null` and would create a nameless organisation. Values are trimmed, so `"launchflow "` is `launchflow` rather than a second tenant.
   - **`published-default`** (production target) — the password must not be one of the defaults printed in this repository.
   - **`confirm-slug`** (production target) — `BOOTSTRAP_CONFIRM` must be set to exactly the `SEED_ORG_SLUG` you are creating (trimmed, and never empty). The bootstrap creates an organisation whenever it finds no row with that slug, so without this a typo would silently make a second, empty organisation and sign you in to that instead. Set it in the web resource's environment beside `SEED_OWNER_PASSWORD`, and remove both together afterwards.

   **"Production target" is the database, not just the variable.** The last two guards run when `NODE_ENV=production` **or** when `DATABASE_URL`'s host is not local — anything other than `localhost`, a `127.x` loopback, `::1`, the compose service names `postgres` / `db`, or a private `10.` / `172.16–31.` / `192.168.` address. A missing or unparseable `DATABASE_URL` counts as production too. This is what stops the run that skips the guards by accident: `DATABASE_URL=postgres://…live… pnpm db:bootstrap` from a restore box, a maintenance container or a laptop, in a shell where nobody exported `NODE_ENV`. Erring this way costs a developer nothing — a local host is recognised on sight — while erring the other way installs a password printed in this repository on a live tenant. The first line of output says which way it read the target, and the `password` line says whether the value came from `SEED_OWNER_PASSWORD` or from the built-in default.

   The bootstrap also reads the repo-root `.env` for any variable that is not already in the environment, including when `DATABASE_URL` was passed on the command line — it used to skip the file entirely in that case, which is how a `SEED_OWNER_PASSWORD` sitting in `.env` could go unread. Variables set explicitly still win over the file.

   A fifth refusal comes later: if the owner email already belongs to a member of that organisation who is not an active owner — an invited staff account, say — the bootstrap stops and says so rather than reporting success, and writes no credential onto that account. An email that already has any `account` row keeps the credential it has ("existing credential kept" in the output). The organisation, user, membership and credential are written in one transaction, so an interrupted run cannot leave an owner who has a membership but no password.

   Agents are left disabled; turn on the ones you want in **Settings → Agents**.

   **Do not run `pnpm db:seed` here.** That is the development fixture: two demo clients with contacts, sites, domains and monitors, five knowledge articles the Support Triage agent will quote to real clients, a fabricated support case, a portal login, and subscriptions, **invoices with numbers allocated from a live sequence**, payments, ad accounts, thirty days of mock ad snapshots and published reports. Invoice numbers in particular are not cleanly reversible. The seed refuses to run against a production target — the same predicate as above, so a remote `DATABASE_URL` is enough on its own — unless `SEED_DEMO=1` is also set, which exists only for a deliberate demo tenant.

6. **Client support addresses** — run this once after the first deploy, and again any time `SUPPORT_EMAIL_DOMAIN` changes or a database carrying more than one organisation is restored or merged:

   ```bash
   docker exec <web-container> pnpm --filter @launchos/db reconcile-support-emails -- --dry-run   # print the plan
   docker exec <web-container> pnpm --filter @launchos/db reconcile-support-emails -- --yes       # apply it
   ```

   A client's support address is stored **twice**: `clients.support_email`, which is what the admin screens display, and `email_identities.address`, which is what inbound mail is actually routed by. The script rewrites **both to the same `<client-slug>@$SUPPORT_EMAIL_DOMAIN`, in one transaction**, and creates the identity row for any client that has none. That is what fixes the two things a migration cannot: rows that migration 0007 backfilled on the hardcoded fallback domain (`ensureEmailIdentity` early-returns when an identity already exists, so it never repairs the routing copy on its own), and the collision that `<slug>` being unique only *per organisation* while both addresses are unique *globally* creates once a second organisation exists (the oldest organisation keeps `<slug>@<domain>`, later ones get `<slug>-<org-slug>@<domain>`). The `unmatched` holding client is skipped: it is the bucket unroutable mail is filed under and must never become deliverable. Each change is written to `audit_log`. It is idempotent and a no-op when everything already matches.

   `SUPPORT_EMAIL_DOMAIN` must be set in the container running it, or it refuses; add `--allow-default-domain` only if you deliberately want everything on `support.launchflow.co.uk`. Without `--yes` it prints the plan and exits without writing, and any unrecognised flag (`--dryrun`, `-n`) is an error rather than a silent apply. Locally the same commands are `pnpm db:reconcile-support-emails -- --dry-run` and `pnpm db:reconcile-support-emails -- --yes`.

7. **Verify** — after first deploy, hit `https://os.launchflow.co.uk/api/health` and confirm `{"ok":true}`, then check the worker resource logs for the `worker started` line.

## Inbound email

Every client has a support address `<client-slug>@$SUPPORT_EMAIL_DOMAIN`. Mail sent to it reaches `POST /api/webhooks/email/inbound`, which validates the shared secret, normalises the payload, writes attachments to `STORAGE_DIR` and enqueues. It performs **no** business writes, so a slow database cannot time the provider out.

### DNS for `SUPPORT_EMAIL_DOMAIN`

Four record sets on the domain, all before anything will route:

| Record | Value |
|---|---|
| `MX` | the inbound host your provider gives you, at the provider's stated priority |
| `TXT` (SPF) | `v=spf1 include:<provider-spf-host> ~all` — one SPF record only; a second is a permanent failure |
| `CNAME` or `TXT` (DKIM) | the selector record the provider issues, copied verbatim |
| `TXT` `_dmarc` | `v=DMARC1; p=none; rua=mailto:you@launchflow.co.uk` to start — tighten to `quarantine` then `reject` only once the reports are clean |

### Postmark

1. Create a server, then enable its inbound stream.
2. Set the inbound webhook to `https://<app-domain>/api/webhooks/email/inbound?provider=postmark`.
3. Add a custom header on that webhook named `x-launchos-inbound-secret` with the `INBOUND_EMAIL_SECRET` value. Without it every delivery is a 401.
4. Point the domain's MX at Postmark's inbound host.
5. Verify the sending signature (the SPF and DKIM records above) in Postmark's sender signatures screen before switching `EMAIL_ADAPTER` to `smtp`.

### Cloudflare Email Routing

1. Enable Email Routing on the zone; Cloudflare adds the MX records for you.
2. Add a catch-all rule that sends to a Worker.
3. The Worker reads the message and POSTs the `normalizeCloudflare` shape — `{ to, from, subject, text, html, headers }`, with the `headers` object carrying at least `message-id` — to `https://<app-domain>/api/webhooks/email/inbound?provider=cloudflare`, with the same `x-launchos-inbound-secret` header.

Cloudflare Email Routing does not forward attachments in this shape. Attachments arrive on the Postmark and generic paths only; a client who emails a screenshot through the Cloudflare path will have their message threaded correctly but the file will not be stored.

### Outbound

Set `EMAIL_ADAPTER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` to a verified sender on the same domain the SPF and DKIM records were published for. Leave `EMAIL_ADAPTER=mock` until those records verify — the mock records the send in `messages` without delivering it, so nothing is lost and nothing goes out misaligned.

### Storage

Mount a persistent volume at `STORAGE_DIR` on the Coolify **web** resource, and give the worker the same path. Without it, every inbound attachment is written to the container's ephemeral filesystem and disappears on the next redeploy, leaving download links pointing at nothing.

### External blockers

None of this works on our side alone. Support intake needs: an inbound provider account (Postmark or Cloudflare), DNS control of `SUPPORT_EMAIL_DOMAIN`, SMTP credentials for outbound, and `ANTHROPIC_API_KEY` for real Support Triage runs. Until each is in place the corresponding path uses its mock and the screens still work — the mail simply never leaves or arrives.

## Branch flow

`main` is production. Feature work happens on branches locally, is tested against docker Postgres, and merges to `main` only after Shoji approves. Coolify deploys `main`.
