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
     - `NODE_ENV=production` — the switch every production guard is keyed on (mock adapters, `LLM=fake`). `infra/Dockerfile.web` sets it on the image too, so a variable lost in a redeploy does not silently disarm them.
     - `DATABASE_URL` → internal Postgres connection string from step 2 (`postgres://<user>:<pass>@<internal-host>:5432/<db>`)
     - `APP_URL` → `https://os.launchflow.co.uk` (match the domain above)
     - `BETTER_AUTH_SECRET` → generate with `openssl rand -base64 32`
     - `BETTER_AUTH_URL` → same as `APP_URL`
     - `ANTHROPIC_API_KEY`
     - `AGENT_MODEL` → `claude-opus-5`
     - `SUPPORT_EMAIL_DOMAIN` → the domain every client support address is minted under (`<client-slug>@<domain>`), e.g. `support.launchflow.co.uk`. Its MX records must point at the inbound mail provider. Unset falls back to `support.launchflow.co.uk` in the app; the reconcile script refuses to run on that fallback unless you pass `--allow-default-domain`, because a mass rewrite onto a domain you do not own is the failure it exists to repair. Changing it later does **not** rewrite addresses already stored on existing clients, and migration `0007_backfill_support_email.sql` fills older rows in with the fallback domain because a migration cannot read env — so **after setting or changing this, run the reconcile script** (see step 6). Inbound routing matches on `email_identities.address` alone, so a client left on the wrong domain silently never receives mail.
     - `OWNER_NOTIFY_EMAIL` → optional. In-app notifications always reach the owner's bell; set this to also email them. Leave unset to keep notifications in-app only.
     - `INBOUND_EMAIL_PROVIDER` → `postmark`, `cloudflare` or `generic`; the payload shape the webhook expects when the URL carries no `?provider=`.
     - `EMAIL_ADAPTER` → `smtp`. **The app refuses to start on `mock` under `NODE_ENV=production`** (see *Production refuses mock adapters* below); until the DNS records verify, set `ALLOW_MOCK_ADAPTERS=1` alongside it and remove that variable the moment they do.
     - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` — required once `EMAIL_ADAPTER=smtp`.
     - `INBOUND_EMAIL_SECRET` → the shared secret the inbound provider sends back in `x-launchos-inbound-secret`.
     - `STORAGE_DIR` → where inbound attachments are written; must be a persistent volume (see **Inbound email** below).
     - `COOLIFY_API_URL`, `COOLIFY_API_TOKEN`
     - `CLOUDFLARE_API_TOKEN`
     - `GOOGLE_ADS_DEVELOPER_TOKEN`
     - `META_ADS_ACCESS_TOKEN`
     - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`
     - `UPTIME_PROBE=http` (mock is for local/test only, and is refused in production)
     - `LLM=anthropic` (fake is for local/test only)
     - `AGENT_POLICY=safe`
     - `ALLOW_MOCK_ADAPTERS` → leave **unset**. Set it to `1` only for a staging resource, or for the window before the SPF and DKIM records verify. Any other value is still a refusal.

4. **Worker resource (Docker build)**
   - New resource → Docker (build from Dockerfile) → same GitHub repo, branch `main`.
   - Dockerfile path: `infra/Dockerfile.worker`
   - Build context: `/` (repo root)
   - No domain, no public port.
   - Health check: process-based (no HTTP endpoint); configure Coolify's restart policy to restart on exit.
   - Auto-deploy: enable "auto deploy on push" for `main`.
   - Deploy after the web resource so migrations have already run once; set it to start after the web resource's health check passes.
   - Env vars: `NODE_ENV=production`, `DATABASE_URL` (same as web), `APP_URL`, `ANTHROPIC_API_KEY`, `AGENT_MODEL`, `LLM=anthropic`, `AGENT_POLICY=safe`, `UPTIME_PROBE=http`, `PAYMENTS_ADAPTER` and the `STRIPE_*` pair, plus `EMAIL_ADAPTER=smtp`, `SMTP_*`, `MAIL_FROM` and `STORAGE_DIR`. The worker is what actually sends outbound mail and reads inbound attachments, so leaving these off the worker used to mean replies were marked `sent` and never left — the worker now refuses to start instead. Its first log line names the LLM, the model, the policy and every resolved adapter.
   - **`NODE_ENV=production` is load-bearing, not decoration.** Every refusal in `apps/worker/src/env.ts` — `LLM=fake` and every adapter rule — is keyed on it, and Node does not default it: a worker started without it passes all of them by not being production. Set it in Coolify's environment variables UI on this resource; `infra/Dockerfile.worker` sets it on the image as well, so the guards survive a variable that did not make it through a redeploy. If both are somehow missing, the worker's first lines are `NODE_ENV unset: production guards are OFF` followed by the adapter set it accepted — that warning means the deployment is unguarded, not that it is healthy.
   - Keep the worker at a **single replica**, for two reasons:
     - The monitor sweep is not safe to run concurrently: two workers would double-count consecutive failures and open duplicate incidents.
     - `sendQueuedMessage`'s claim is a **five-minute lease, not a lock** (`CLAIM_TTL_MINUTES`), so it only guarantees that a second delivery cannot claim a message whose claim is under five minutes old. What actually prevents a client receiving the same reply twice is that one worker's `boss.work` does not overlap handlers. `SmtpEmailAdapter` sets no `socketTimeout`, so nodemailer's ten-minute default outlives the lease comfortably. A second replica would make a hung send re-sendable at t+5m — do not add one without either a lock that outlives the send or an SMTP timeout below five minutes.

5. **First owner account** — sign-up is disabled in the app (`emailAndPassword.disableSignUp`), so the first account has to be written directly. Run the **bootstrap**, once, inside the running web container:

   ```bash
   docker exec <web-container> pnpm db:bootstrap
   ```

   It creates exactly two things: the organisation, from `SEED_ORG_NAME` and `SEED_ORG_SLUG` (defaults `LaunchFlow` / `launchflow`), and the owner user and its credential, from `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD`, with an owner membership joining them. Nothing else. Set `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD` in the web resource's environment variables before running it — **neither has a default here**, and the email is the address you will sign in as — then **remove the password variable and redeploy** once you have signed in. It is idempotent, and re-running it never changes an existing password — to rotate one, sign in and change it.

   Five guards run before a connection is even opened. Each refusal prints the guard's name and the reason, and exits non-zero — a bootstrap that did not do what you asked never looks like one that did:

   - **`password-floor`** (every environment) — `SEED_OWNER_PASSWORD` must be at least 12 characters, the same floor the app enforces on every staff and client account. Better Auth only re-checks a password on sign-up, change and reset, none of which this account will go through, so this is the only place the floor can be applied to it.
   - **`organisation-slug`** (every environment) — `SEED_ORG_SLUG` must be 2–63 characters of lowercase letters, digits and hyphens. Leaving the variable unset uses `launchflow`; setting it to an empty value is a refusal, because an empty slug satisfies `not null` and would create a nameless organisation. Values are trimmed, so `"launchflow "` is `launchflow` rather than a second tenant.
   - **`owner-email`** (every environment) — `SEED_OWNER_EMAIL` must be set, and must look like an address. **There is no default.** It used to fall back to an address committed to this repository, so an install that forgot the variable created its one privileged account — the owner, who sees every client, invoice and approval — under somebody else's address, and was told "owner user … created". The value is trimmed, and a bare name, a slug or a shell-mangled fragment is refused rather than becoming a user row nobody can sign in to. The development seed keeps a default, and is the only thing that does.
   - **`published-default`** (every environment) — the password must not be one of the defaults printed in this repository.
   - **`confirm-slug`** (every environment) — `BOOTSTRAP_CONFIRM` must be set to exactly the `SEED_ORG_SLUG` you are creating (trimmed, and never empty). The bootstrap creates an organisation whenever it finds no row with that slug, so without this a typo would silently make a second, empty organisation and sign you in to that instead. Set it in the web resource's environment beside `SEED_OWNER_PASSWORD`, and remove both together afterwards.

   **All five run everywhere, against every host — there is no "local" exemption.** These two were briefly keyed on a host-derived "production target" predicate, and that is the hole this closes: **no string test can tell a local database from a live one.** `ssh -L 5433:<coolify-postgres>:5432 hetzner` presents production as `localhost:5433`; a Hetzner Cloud private network is `10.0.0.0/16`; and `infra/docker-compose.coolify.yml` — this repository's own *production* topology — names its database host `postgres`. Each of those reads as local, and each is a normal way to reach a production database. The bootstrap has no legitimate published-default use, so it simply never allows one.

   The cost is one line locally. To bootstrap a development database, pass an address, a real password and the confirmation for that run:

   ```bash
   SEED_OWNER_EMAIL=you@example.com SEED_OWNER_PASSWORD='a-real-long-password' BOOTSTRAP_CONFIRM=launchflow pnpm db:bootstrap
   ```

   The everyday local path is `pnpm db:seed`, which is unchanged and still runs on the shipped defaults.

   The output's first two lines are the database (host and name, never the credentials) and the **absolute path of the `.env` it read**; the `password` line says whether the value came from `SEED_OWNER_PASSWORD` or from the built-in default. `pnpm db:seed` prints the same three.

   That `.env` is always the repo-root one, located from the script's own file position (`packages/db/src/…` → three directories up) rather than from the working directory, so running the script from anywhere reads the same file — a ladder of `../../.env`, `../.env`, `.env` candidates relative to the cwd used to read a file *outside the repository* when run from the repository root. It fills in any variable that is not already in the environment, including when `DATABASE_URL` was passed on the command line; variables set explicitly still win over the file. Note that `NODE_ENV` is one of those variables: a repo-root `.env` carrying `NODE_ENV=production` turns the seed's production guards on locally. That is the fail-safe direction, and the converse cannot happen — unset and `development` are identical to the predicate, and the file never overrides an exported variable.

   A fifth refusal comes later: if the owner email already belongs to a member of that organisation who is not an active owner — an invited staff account, say — the bootstrap stops and says so rather than reporting success, and writes no credential onto that account. An email that already has any `account` row keeps the credential it has ("existing credential kept" in the output). The organisation, user, membership and credential are written in one transaction, so an interrupted run cannot leave an owner who has a membership but no password.

   Agents are left disabled; turn on the ones you want in **Settings → Agents**.

   **Do not run `pnpm db:seed` here.** That is the development fixture: two demo clients with contacts, sites, domains and monitors, five knowledge articles the Support Triage agent will quote to real clients, a fabricated support case, a portal login, and subscriptions, **invoices with numbers allocated from a live sequence**, payments, ad accounts, thirty days of mock ad snapshots and published reports. Invoice numbers in particular are not cleanly reversible. The seed refuses to run against a **production target** unless `SEED_DEMO=1` is also set, which exists only for a deliberate demo tenant. It applies the same refusal to a password that is still a published default, and to `SEED_CLIENT_PASSWORD` being equal to `SEED_OWNER_PASSWORD`.

   **"Production target" is the seed's predicate, and it is the database rather than just the variable:** `NODE_ENV=production`, **or** a `DATABASE_URL` whose host is not local. Local means `localhost`, a `127.x` loopback, IPv6 loopback in any spelling (`::1`, `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`), the compose service names `postgres` / `db`, a private `10.` / `172.16–31.` / `192.168.` address, or an IPv6 unique-local `fc00::/7` address. Everything else is production, including a missing or unparseable `DATABASE_URL`, a **hostless** one (the unix-socket form `postgres:///launchos`) and a comma-separated **multi-host** one — postgres.js accepts both and neither resolves to a single host that can be judged. Keying this on `NODE_ENV` alone meant a demo seed against a live database from a shell where nobody exported it was the one run that skipped the check; inferring from the host is good enough *here*, where being wrong the other way would refuse every local `pnpm db:seed`. It is not good enough for a credential, which is why the bootstrap's own guards above do not use it.

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

### Production refuses mock adapters

Under `NODE_ENV=production` both the web app and the worker validate their environment before opening a connection, and **refuse to start when an adapter resolves to a mock**. The rule lives in one place, `packages/integrations/src/adapter-guard.ts`, so the two processes cannot disagree.

Where each one runs it, because "refuses to start" is only true if something actually evaluates it:

| Process | Entry point | When |
|---|---|---|
| worker | `loadEnv()` in `main()` (`apps/worker/src/env.ts`) | before pg-boss connects |
| web | `register()` in `apps/web/src/instrumentation.ts` | once per server start, before the first request is handled |

The web half is a hook rather than a module import on purpose: `src/lib/env.ts` validates when it is *first imported*, and under `next start` that is on demand, per route — only five server actions import it, and the modules that build an email adapter (`invoices/actions.ts`, `settings/email/actions.ts`) are not among them. A container that validated nothing until someone visited the right page would pass its health check, render the dashboard and send invoices through the mock. Next's `register()` is the one hook guaranteed to complete before the server takes a request, so a refusal there is a container that never comes up.

And both processes only get that far if `NODE_ENV=production` is actually set — see step 4. Both images set it (`infra/Dockerfile.web`, `infra/Dockerfile.worker`) and both resources should set it too.

The reasoning is `ALLOW_FAKE_LLM`'s, one step worse: a mock adapter does not fail, it *succeeds*. `MockEmailAdapter` returns a message id, so a worker whose `EMAIL_ADAPTER` was lost in a redeploy marks every client reply, ad report and invoice email `sent` — with a `delivered_at` and a `mock-…` external id — and delivers none of them. Nothing anywhere says otherwise. A doc listing the variable is not a guard.

Refused:

| Variable | Refused value | Why |
|---|---|---|
| `EMAIL_ADAPTER` | `mock` (including unset) | every outbound email is recorded as delivered and sent nowhere |
| `PAYMENTS_ADAPTER` | `mock` (including unset) | invoices are raised against a fake ledger |
| `UPTIME_PROBE` | `mock` (including unset) | every site reports up, so no incident is ever opened |
| `PAYMENTS_ADAPTER` | `stripe` with `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` missing | the factory silently builds the mock, so the deployment believes it is live |
| `ADS_ADAPTER` | `google` / `meta` | interface-only adapters; the factory still builds the mock |

Not refused, because they have no real implementation yet: `ADS_ADAPTER=mock`, and the hosting, DNS and CMS providers, which no env var selects. Refusing those would refuse production outright and teach everyone to set the opt-out permanently, which would disarm the whole guard. They are printed at startup instead.

**The opt-out is `ALLOW_MOCK_ADAPTERS=1`**, spelled exactly — `true`, `yes` and `1 ` are all still refusals. Use it for a staging resource, or for the window between the first production deploy and the SPF/DKIM records verifying, and remove it as soon as the real adapters are configured. Every refusal names the variable and says what the mock would have done, and all of them are reported at once rather than one per restart.

**It is all-or-nothing, so treat the DNS window as short and supervised.** `ALLOW_MOCK_ADAPTERS=1` disarms the rule for *every* adapter, not just email: while it is set, `UPTIME_PROBE=mock` (no incident is ever opened) and `PAYMENTS_ADAPTER=mock` (invoices raised against a fake ledger) pass unremarked as well. Nothing expires the variable and nothing reminds you it is set — the startup line names the adapters, but the premise of this whole section is that a log line is not a guard. So set `UPTIME_PROBE=http` and the real `PAYMENTS_ADAPTER` *before* you set the opt-out, keep it only for the email window, and delete it the moment SPF and DKIM verify. Making the opt-out per-adapter (`ALLOW_MOCK_ADAPTERS=email`) is the outstanding fix.

One exemption, deliberately: `next build` sets `NODE_ENV=production` itself and imports every module a page reaches, and `infra/Dockerfile.web` runs that build long before the runtime environment exists. The web app therefore skips the refusal while `NEXT_PHASE=phase-production-build` — a build sends nothing — and applies it at `next start`, where a real request could be served on a mock. Next never calls `register()` under that phase either, so the hook adds nothing to a build; the exemption inside `src/lib/env.ts` stays because the build reaches that module directly through the server actions that import it. Its cost is that a process started with `NEXT_PHASE=phase-production-build` set by hand would skip the refusal — `next start` never sets it, and neither Dockerfile exports it past the build layer, so do not add it to a Coolify variable set. The worker has no build-time import of its env at all.

Both processes log the resolved adapter names — names only, never hosts, keys or addresses — at server start: the worker's `worker started` line carries `adapters: { email, payments, uptime, ads, hosting, dns, cms }` (preceded by its `NODE_ENV=…` line), and the web app logs the same set as `web adapters` when `register()` loads the env module. Check those lines after every redeploy; they are the cheapest way to notice a variable that did not survive one.

### Cloudflare Email Routing

1. Enable Email Routing on the zone; Cloudflare adds the MX records for you.
2. Add a catch-all rule that sends to a Worker.
3. The Worker reads the message and POSTs the `normalizeCloudflare` shape — `{ to, from, subject, text, html, headers }`, with the `headers` object carrying at least `message-id` — to `https://<app-domain>/api/webhooks/email/inbound?provider=cloudflare`, with the same `x-launchos-inbound-secret` header.

Cloudflare Email Routing does not forward attachments in this shape. Attachments arrive on the Postmark and generic paths only; a client who emails a screenshot through the Cloudflare path will have their message threaded correctly but the file will not be stored.

### Outbound

Set `EMAIL_ADAPTER=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `MAIL_FROM` to a verified sender on the same domain the SPF and DKIM records were published for. Leaving `EMAIL_ADAPTER=mock` until those records verify is a deliberate choice, not a default — the mock marks the message `sent` in `messages` without delivering it, so nothing goes out misaligned but nothing goes out at all — and in production it needs `ALLOW_MOCK_ADAPTERS=1` beside it. Remove that variable and redeploy the moment the records verify.

A reply the client never receives no longer passes silently either. When a send exhausts `MAX_SEND_ATTEMPTS` (5) the message flips to `failed`, and that now writes a `message.send_failed` entry on the client's timeline and one notification for the owner. A message still `queued` 24 hours later — the point at which `outbound.sweep` stops re-driving it — gets one owner notification too. Both are stamped in `messages.metadata` so they are said once, however often the sweep runs. The announcement itself can never cost the give-up it is announcing: the recipient address and the relay's error are truncated to fit the notification limits, and a failure to write either row is logged rather than thrown — a message that has been given up on is not visible to `outbound.sweep`, so a throw there would have meant nobody ever heard about it.

### Storage

Mount a persistent volume at `STORAGE_DIR` on the Coolify **web** resource, and give the worker the same path. Without it, every inbound attachment is written to the container's ephemeral filesystem and disappears on the next redeploy, leaving download links pointing at nothing.

### External blockers

None of this works on our side alone. Support intake needs: an inbound provider account (Postmark or Cloudflare), DNS control of `SUPPORT_EMAIL_DOMAIN`, SMTP credentials for outbound, and `ANTHROPIC_API_KEY` for real Support Triage runs. Until each is in place the corresponding path uses its mock and the screens still work — the mail simply never leaves or arrives.

## Branch flow

`main` is production. Feature work happens on branches locally, is tested against docker Postgres, and merges to `main` only after Shoji approves. Coolify deploys `main`.
