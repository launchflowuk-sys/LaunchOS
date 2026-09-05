# Deployment

## Local

```bash
cp .env.example .env
openssl rand -base64 48   # paste into BETTER_AUTH_SECRET in .env — it ships blank (minimum 32 characters)
openssl rand -base64 48   # and again, into INBOUND_EMAIL_SECRET — it ships blank too (minimum 24)
pnpm install
pnpm db:up                # postgres:17 on localhost:5432
pnpm db:migrate
pnpm db:seed              # demo fixtures; runs only on SEED_DEMO=1, which .env.example ships set
pnpm dev                  # web
pnpm dev:worker           # worker; `.env.example` ships LLM=fake, so this needs no ANTHROPIC_API_KEY
```

`BETTER_AUTH_SECRET` and `INBOUND_EMAIL_SECRET` are the two variables `.env.example` cannot supply, because a value published in this repository is not a secret. `apps/web/src/lib/env.ts` refuses a blank one, one under 32 (auth) or 24 (inbound) characters, and any placeholder shipped here — **in every environment, not only production**. Generate both before `pnpm dev`, or the web app refuses to start and `pnpm test` fails at import (vitest dotenv-loads the repo-root `.env` for every package). On Windows, `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"` does the same job as `openssl rand -base64 48`.

The worker runs on the fake LLM out of the box: `.env.example` ships `LLM=fake`, which needs no `ANTHROPIC_API_KEY` and answers every agent run from a scripted stub (`apps/worker/src/llm/fake.ts`). For real agent runs set `ANTHROPIC_API_KEY` and `LLM=anthropic`. Production must carry `LLM=anthropic` — the worker refuses `LLM=fake` under `NODE_ENV=production` unless `ALLOW_FAKE_LLM=1` says it was meant.

Tests: `pnpm test` needs the docker Postgres running. Integration tests run against `DATABASE_URL_TEST` if set, otherwise `DATABASE_URL` — no separate test database is created. Each test runs inside a transaction that is always rolled back, and test data uses unique slugs (for example `test-${crypto.randomUUID()}` for `organisations.slug`), so it never collides with the seeded data.

## Production (Coolify on Hetzner)

Three Coolify resources in one project, all on the same internal network:

1. **postgres** — Coolify managed PostgreSQL 17 with a persistent volume and daily backups to Hetzner storage box. Not exposed publicly.
2. **web** — Docker build from `infra/Dockerfile.web`. Domain `os.launchflow.co.uk` (or chosen). Health check `GET /api/health`.
3. **worker** — Docker build from `infra/Dockerfile.worker`. No public port. Health check is the process itself.

Both app resources auto-deploy from `main` on GitHub push. **Migrations are a one-shot step, not part of either entrypoint** — Coolify runs `pnpm --filter @launchos/db migrate` as the web resource's *pre-deployment command*, before the new container starts serving. See "Migrations" below for why, and for the manual equivalent.

Environment variables are set in Coolify, never committed. `NODE_ENV=production`, `APP_URL`, `BETTER_AUTH_URL` and `DATABASE_URL` point at the internal Postgres hostname.

### Migrations

`drizzle-kit migrate` runs **once per deploy, before the serving container starts**, as Coolify's pre-deployment command on the web resource:

```
pnpm --filter @launchos/db migrate
```

It used to be the web container's `CMD` (`pnpm db:migrate && next start`). Three reasons it is not any more, all of them things the entrypoint form gets wrong:

- A failing migration became a **crash-loop outage of both portals** rather than a deferred schema change: `&&` short-circuits, the container exits, Coolify restarts it, and it fails identically forever.
- Scaling web past one replica would run `drizzle-kit migrate` concurrently against one database with no advisory lock.
- There was no way to apply a migration without restarting the app, and no way to restart the app without applying one.

A pre-deployment command runs in a container built from the same image, so nothing else changes: the migrations and `drizzle-kit` are already in `infra/Dockerfile.web` (`COPY packages ./packages` plus the dev dependencies the build installs). If the Coolify version in use has no pre-deployment hook, the equivalent is a manual step before promoting the deploy:

```bash
docker exec <web-container> pnpm --filter @launchos/db migrate
```

**Before applying a migration that adds a constraint, check the rows it will refuse.** `0011_large_prima.sql` adds two unique indexes to tables that predate them. It is safe on a database at `main`'s state (0000–0002) — `billing_profiles` arrives in 0003 and `invoice_send` approvals can only be written by Plan 5 code — but the next constraint on a database that has been running Plan 5 is a different matter, and a migration that fails halfway through a deploy is the worst time to find out. The two pre-flight queries for 0011, recorded while the reasoning is fresh:

```sql
SELECT stripe_customer_id, count(*) FROM billing_profiles
WHERE stripe_customer_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1;

SELECT organisation_id, payload->>'invoiceId', count(*) FROM approvals
WHERE status='pending' AND kind='message_send' AND payload->>'action'='invoice_send'
GROUP BY 1,2 HAVING count(*) > 1;
```

Both must return no rows. If either returns one, resolve the duplicates first — the migration cannot.

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
   - Pre-deployment command: `pnpm --filter @launchos/db migrate` (see **Migrations** above — it is deliberately not in the container's entrypoint).
   - Env vars: **the full list is the table below.** It is the variables the web process actually reads — `apps/web/src/lib/env.ts`'s schema, the adapter guard it calls (`packages/integrations/src/adapter-guard.ts`, `AdapterEnv`), and the modules that read `process.env` directly. Set them in Coolify's environment variables UI, never committed; the keys match `.env.example`. A variable the code does not read is marked as such rather than left to look load-bearing.

   **Web — refuses to start without these**

   | Variable | Value | Read by |
   |---|---|---|
   | `DATABASE_URL` | internal Postgres string from step 2 (`postgres://<user>:<pass>@<internal-host>:5432/<db>`) | `lib/db.ts`, `lib/queue.ts`, Better Auth. Validated at boot — a missing or non-URL value is a container that does not come up |
   | `BETTER_AUTH_SECRET` | **generate with `openssl rand -base64 48`** | `lib/auth.ts`. Validated at boot: blank, under 32 characters, or any placeholder published in this repository (`change-me`, `change-me-now`, …) is a refusal. It signs every session cookie, so a published value is session forgery for any account, `owner` included |
   | `APP_URL` | `https://os.launchflow.co.uk` (match the domain above) | portal links in client emails, the Stripe webhook endpoint shown on Settings → Billing. Defaults to `http://localhost:3000`, which in production is a link clients cannot follow |
   | `INBOUND_EMAIL_SECRET` | **generate with `openssl rand -base64 48`** | the only credential on `POST /api/webhooks/email/inbound`. Validated at boot in **every** environment: blank, under 24 characters, or any placeholder published in this repository is a refusal, so a resource that has it unset is a container that never becomes healthy. It is required **before** an inbound provider exists — an unset secret is not "inbound is off", it is an unauthenticated route that raises tickets and conversations against any client |

   **Web — set these too, but nothing validates them: a wrong value fails silently**

   | Variable | Value | Read by |
   |---|---|---|
   | `NODE_ENV` | `production` | every production guard is keyed on it (mock adapters, `LLM=fake`). Not on the `Env` schema and not checked anywhere — a resource that loses it passes every guard by not being production. `infra/Dockerfile.web` sets it on the image too, which is what stops a variable lost in a redeploy from silently disarming them |
   | `BETTER_AUTH_URL` | same as `APP_URL` | Better Auth's own base URL; falls back to `APP_URL` when unset. Unvalidated — a value that disagrees with `APP_URL` breaks sign-in callbacks with no startup complaint, so set it from `APP_URL` or leave it off entirely |

   **Web — adapters (a mock here is refused in production; see *Production refuses mock adapters* below)**

   | Variable | Value | Notes |
   |---|---|---|
   | `EMAIL_ADAPTER` | `smtp` | `mock`, including unset, is a refusal. Until the DNS records verify, set `ALLOW_MOCK_ADAPTERS=1` alongside it and remove that variable the moment they do |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | your relay | required once `EMAIL_ADAPTER=smtp`; `EMAIL_ADAPTER=smtp` with no `SMTP_HOST` is also a refusal, because the factory would throw rather than downgrade |
   | `PAYMENTS_ADAPTER` | `stripe` | **this one was missing from this list and a web resource built to the letter of it would not boot.** `mock`, including unset, is a refusal |
   | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | from Stripe | `=stripe` with either one missing is *also* a refusal — the factory silently builds the mock, so the deployment would believe it is live. `POST /api/webhooks/stripe` lives in **this** process and reads `STRIPE_WEBHOOK_SECRET` here, not on the worker |
   | `UPTIME_PROBE` | `http` | `mock` reports every site up, so no incident is ever opened |
   | `ADS_ADAPTER` | `mock`, or `google` / `meta` as an intent | selection is **by credential** (see *Real adapters and their keys*); `google` / `meta` here only says the platform is meant, so missing keys are refused rather than quietly mocked |
   | `ALLOW_MOCK_ADAPTERS` | leave **unset** | set it to exactly `1` only for a staging resource, or for the window before SPF and DKIM verify. Any other value is still a refusal |

   **Web — support intake and money**

   | Variable | Value | Read by |
   |---|---|---|
   | `SUPPORT_EMAIL_DOMAIN` | e.g. `support.launchflow.co.uk` | `packages/core/src/config.ts`, Settings → Email. See the note under this table |
   | `INBOUND_EMAIL_PROVIDER` | `postmark`, `cloudflare` or `generic` | the payload shape `POST /api/webhooks/email/inbound` expects when the URL carries no `?provider=` |
   | `STORAGE_DIR` | e.g. `/data/attachments` | where inbound attachments are written; **must be a persistent volume**, mounted at the same path on the worker (see **Storage**) |
   | `OWNER_NOTIFY_EMAIL` | optional | in-app notifications always reach the owner's bell; set this to also email them |
   | `VAT_RATE` | `20` | whole-number percentage. Unset falls back to 20; **set-but-empty is a refusal**, and a Coolify variable created and left blank is exactly how that happens — the alternative was every invoice going out at 0% with nothing to show for it |
   | `PAYMENT_TERMS_DAYS` | `14` | invoice due date, `packages/integrations/src/payments/index.ts` |

   **Web — the real hosting, DNS, CMS and ads adapters**

   `COOLIFY_API_URL`, `COOLIFY_API_TOKEN` (+ optional `COOLIFY_SERVER_UUID`, `COOLIFY_TIMEOUT_MS`), `HOSTINGER_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `SECRETS_ENCRYPTION_KEY`, the five `GOOGLE_ADS_*` keys and the two `META_ADS_*` keys (+ optional `GOOGLE_ADS_API_VERSION`, `META_ADS_API_VERSION`, `META_ADS_CONVERSION_ACTIONS`). Same values on both resources: the web app reads them for the Websites → WordPress connection form and its Test button, the Settings → Billing badges, and the agent catalogue; the worker for every agent run and the ads ingest. Where each one comes from is in **Real adapters and their keys** below. Unset means the mock — tolerated in production, warned about at startup, and never refused for being absent.

   **Web — displayed on Settings → Billing, never used**

   `STRIPE_PUBLISHABLE_KEY` — rendered as "Set" / "Not set". The ads keys on that screen are the real ones above, read off the factory's own list.

   **Web — placeholders: nothing reads these, do not go and acquire them**

   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`. The WhatsApp channel does not exist yet. They are named here only so this list and `.env.example` agree.

   **Not on the web resource:** `ANTHROPIC_API_KEY`, `AGENT_MODEL`, `LLM`, `AGENT_POLICY` and `ALLOW_FAKE_LLM` are read by the **worker**, which is where agent runs happen — the web app only enqueues `agent.run`. Setting them here is harmless but nothing reads them; leaving them off the *worker* is what breaks agents.

   About `SUPPORT_EMAIL_DOMAIN`: it is the domain every client support address is minted under (`<client-slug>@<domain>`), e.g. `support.launchflow.co.uk`. Its MX records must point at the inbound mail provider. Unset falls back to `support.launchflow.co.uk` in the app; the reconcile script refuses to run on that fallback unless you pass `--allow-default-domain`, because a mass rewrite onto a domain you do not own is the failure it exists to repair. Changing it later does **not** rewrite addresses already stored on existing clients, and migration `0007_backfill_support_email.sql` fills older rows in with the fallback domain because a migration cannot read env — so **after setting or changing this, run the reconcile script** (see step 6). Inbound routing matches on `email_identities.address` alone, so a client left on the wrong domain silently never receives mail.

4. **Worker resource (Docker build)**
   - New resource → Docker (build from Dockerfile) → same GitHub repo, branch `main`.
   - Dockerfile path: `infra/Dockerfile.worker`
   - Build context: `/` (repo root)
   - No domain, no public port.
   - Health check: process-based (no HTTP endpoint); configure Coolify's restart policy to restart on exit.
   - Auto-deploy: enable "auto deploy on push" for `main`.
   - Deploy after the migration step has run at least once (it is the web resource's pre-deployment command — see **Migrations**). Starting it after the web resource's health check passes is a reasonable ordering, but it is no longer what applies the schema.
   - Env vars: **the full list is the table below** — the schema in `apps/worker/src/env.ts` plus the variables its factories read from `process.env` directly. It is deliberately the same shape as the web table above: anything in both must carry the same value in both.

   | Variable | Value | Notes |
   |---|---|---|
   | `NODE_ENV` | `production` | **load-bearing, not decoration** — see the note below |
   | `DATABASE_URL` | same as web | required; pg-boss and every service read it |
   | `APP_URL` | same as web | the portal link the Ad Sentinel puts in client emails. **A boot refusal under `NODE_ENV=production`** when unset or left on `http://localhost:3000` — the same rule as web, by value, so a live resource carrying the loopback default does not start |
   | `ANTHROPIC_API_KEY` | from Anthropic | required whenever `LLM=anthropic`; without it every agent run fails one at a time after its run row is already open |
   | `AGENT_MODEL` | `claude-opus-5` | |
   | `LLM` | `anthropic` | `fake` is a scripted stub; it is refused under `NODE_ENV=production` unless `ALLOW_FAKE_LLM=1` |
   | `ALLOW_FAKE_LLM` | leave **unset** | the one way to run the fake client in production, and it has to be typed out on purpose |
   | `AGENT_POLICY` | `safe` | `approval_all` queues even `safe` tools for a human |
   | `EMAIL_ADAPTER` | `smtp` | the worker is what actually sends outbound mail; `mock` marks every reply, ad report and invoice email `sent` and delivers none |
   | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | your relay | `SMTP_USER` / `SMTP_PASS` are read by the factory from `process.env`, not by the schema |
   | `PAYMENTS_ADAPTER` | `stripe` | with `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`; either one missing is a refusal, not a downgrade |
   | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | from Stripe | the webhook *route* is on web, but the guard here refuses a payments adapter it cannot build |
   | `UPTIME_PROBE` | `http` | the monitor sweep runs here; `mock` reports every site up |
   | `ADS_ADAPTER` | as on web | intent only; the `GOOGLE_ADS_*` / `META_ADS_*` keys select |
   | `COOLIFY_API_URL`, `COOLIFY_API_TOKEN`, `HOSTINGER_API_TOKEN`, `CLOUDFLARE_API_TOKEN`, `SECRETS_ENCRYPTION_KEY`, `GOOGLE_ADS_*`, `META_ADS_*` | same as web | the real hosting, DNS, CMS and ads adapters — this is the process whose agent runs and ads ingest use them. See *Real adapters and their keys* |
   | `SUPPORT_EMAIL_DOMAIN` | same as web | used when the worker mints or matches a support address |
   | `STORAGE_DIR` | same path as web | inbound attachments; the **same persistent volume**, or the worker reads an empty directory |
   | `OWNER_NOTIFY_EMAIL` | optional | send-failure and give-up notices are emailed here as well as belled |
   | `VAT_RATE`, `PAYMENT_TERMS_DAYS` | `20`, `14` | keep identical to web, or an invoice is raised and rendered on different numbers |
   | `ALLOW_MOCK_ADAPTERS` | leave **unset** | same rule, same spelling, same warning as web |

   Not read by the worker: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `INBOUND_EMAIL_SECRET`, `INBOUND_EMAIL_PROVIDER` (web only — sessions and the inbound webhook are its job), and every placeholder in the web list. Its first log line names the LLM, the model, the policy and every resolved adapter.
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

   The everyday local path is `pnpm db:seed`, which runs on the shipped defaults and needs only `SEED_DEMO=1` — which `.env.example` ships set, so `cp .env.example .env` covers it.

   The output's first two lines are the database (host and name, never the credentials) and the **absolute path of the `.env` it read**; the `password` line says whether the value came from `SEED_OWNER_PASSWORD` or from the built-in default. `pnpm db:seed` prints the same three.

   That `.env` is always the repo-root one, located from the script's own file position (`packages/db/src/…` → three directories up) rather than from the working directory, so running the script from anywhere reads the same file — a ladder of `../../.env`, `../.env`, `.env` candidates relative to the cwd used to read a file *outside the repository* when run from the repository root. It fills in any variable that is not already in the environment, including when `DATABASE_URL` was passed on the command line; variables set explicitly still win over the file. Note that `NODE_ENV` is one of those variables: a repo-root `.env` carrying `NODE_ENV=production` makes the seed treat the target as live, so it then requires `SEED_OWNER_EMAIL` to be set. That is the fail-safe direction, and the converse cannot happen — unset and `development` are identical to the predicate, and the file never overrides an exported variable.

   A fifth refusal comes later: if the owner email already belongs to a member of that organisation who is not an active owner — an invited staff account, say — the bootstrap stops and says so rather than reporting success, and writes no credential onto that account. An email that already has any `account` row keeps the credential it has ("existing credential kept" in the output). The organisation, user, membership and credential are written in one transaction, so an interrupted run cannot leave an owner who has a membership but no password.

   Agents are left disabled; turn on the ones you want in **Settings → Agents**.

   **Do not run `pnpm db:seed` here, and never set `SEED_DEMO` on a production resource.** The seed is the development fixture: two demo clients with contacts, sites, domains and monitors, five knowledge articles the Support Triage agent will quote to real clients, a fabricated support case, a portal login, and subscriptions, **invoices with numbers allocated from a live sequence**, payments, ad accounts, thirty days of mock ad snapshots and published reports. Invoice numbers in particular are not cleanly reversible, and the owner credential it writes is the same one the bootstrap writes.

   **`pnpm db:seed` refuses to run at all unless `SEED_DEMO=1`** — guard `demo-opt-in`, in every environment, against every host, before a connection is opened. That flag is the *gate*, and it is the only guard that can be trusted on its own, because **no host string can tell a local database from a live one**: a tunnelled database (`localhost:5433`), a private-network address (`10.x`), and this repository's own production compose hostname (`postgres`) all read as local. It replaces the old `demo-fixtures-in-production` gate, which was keyed on that host guess and was therefore skipped by exactly the runs that needed it. `.env.example` ships `SEED_DEMO=1`, so local development is unaffected — `cp .env.example .env` supplies it. The production environment must simply not carry the variable, and the production path is `pnpm db:bootstrap` above.

   **Two credential refusals run beside the flag, not instead of it** — `assertSeedPasswords` in `packages/db/src/seed.ts`. `published-default` refuses either account whose password is still one printed in this repository (`change-me-now`, `change-me-client`), checked **by value** rather than by variable, so swapping the two around is caught as well; `shared-password` refuses two equal passwords, because satisfying the first by setting both to the same real value hands a client the owner's sign-in. Both fire when `NODE_ENV=production` **or** the database is not demonstrably local — the production shapes a host string *can* recognise. They are belt and braces for the one case that matters: a `SEED_DEMO=1` carried across from `.env.example` onto a live resource. Being wrong the local way is free, so `cp .env.example .env && pnpm db:seed` still runs on the shipped defaults.

   **"Production target" survives in the seed for three things, and guards nothing else:** the `(local)` / `(production target)` note on its printed database line, the rule that `SEED_OWNER_EMAIL` must be *set* rather than defaulted when the target is not demonstrably local, and the two credential refusals above. The predicate is `NODE_ENV=production`, **or** a `DATABASE_URL` whose host is not local — local meaning `localhost`, a `127.x` loopback, IPv6 loopback in any spelling (`::1`, `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`), the compose service names `postgres` / `db`, a private `10.` / `172.16–31.` / `192.168.` address, or an IPv6 unique-local `fc00::/7` address. Everything else counts as production, including a missing or unparseable `DATABASE_URL`, a **hostless** one (the unix-socket form `postgres:///launchos`) and a comma-separated **multi-host** one — postgres.js accepts both and neither resolves to a single host that can be judged. Being wrong there costs one environment variable or a password you were going to change anyway, which is the only kind of decision a hostname is good enough to make.

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
| `COOLIFY_API_URL` / `COOLIFY_API_TOKEN` | one set without the other | same silent downgrade: the factory builds the mock, which answers healthy numbers for every ref |
| `COOLIFY_API_URL` | not an http(s) URL | the factory throws by design; refused even with the opt-out, because a config that throws is not one anyone can mean |
| `GOOGLE_ADS_*` / `META_ADS_*` | a platform partly set (three of the five Google keys, one of the two Meta keys) | that platform falls back to the mock series while the operator believes it is live |
| `ADS_ADAPTER` | `google` / `meta` with that platform's keys missing | the intent is stated and not backed — a redeploy that lost the credentials |

**Not refused for being unset — warned about instead:** the hosting, DNS, CMS and ads adapters. Their real clients landed after production was already running with none of their keys set, and a deployment whose domains are all `registrar` / `other`, or which has no ad accounts yet, is sound without them; refusing would have refused the next deploy outright and taught everyone to set the opt-out permanently, which disarms the whole guard. Instead both processes print one `WARN` line per mock they are running on — `hosting adapter is the MOCK (COOLIFY_API_URL unset): hosting_get_resources answers healthy numbers for every ref…` — through `productionMockWarnings`, the same module as the refusals. Set-but-unusable is still refused, as the rows above say. (`ADS_ADAPTER=mock` is not refused either; it says nothing.)

**The opt-out is `ALLOW_MOCK_ADAPTERS=1`**, spelled exactly — `true`, `yes` and `1 ` are all still refusals. Use it for a staging resource, or for the window between the first production deploy and the SPF/DKIM records verifying, and remove it as soon as the real adapters are configured. Every refusal names the variable and says what the mock would have done, and all of them are reported at once rather than one per restart.

**It is all-or-nothing, so treat the DNS window as short and supervised.** `ALLOW_MOCK_ADAPTERS=1` disarms the rule for *every* adapter, not just email: while it is set, `UPTIME_PROBE=mock` (no incident is ever opened) and `PAYMENTS_ADAPTER=mock` (invoices raised against a fake ledger) pass unremarked as well. Nothing expires the variable and nothing reminds you it is set — the startup line names the adapters, but the premise of this whole section is that a log line is not a guard. So set `UPTIME_PROBE=http` and the real `PAYMENTS_ADAPTER` *before* you set the opt-out, keep it only for the email window, and delete it the moment SPF and DKIM verify. Making the opt-out per-adapter (`ALLOW_MOCK_ADAPTERS=email`) is the outstanding fix.

One exemption, deliberately: `next build` sets `NODE_ENV=production` itself and imports every module a page reaches, and `infra/Dockerfile.web` runs that build long before the runtime environment exists. The web app therefore skips the refusal while `NEXT_PHASE=phase-production-build` — a build sends nothing — and applies it at `next start`, where a real request could be served on a mock. Next never calls `register()` under that phase either, so the hook adds nothing to a build; the exemption inside `src/lib/env.ts` stays because the build reaches that module directly through the server actions that import it. Its cost is that a process started with `NEXT_PHASE=phase-production-build` set by hand would skip the refusal — `next start` never sets it, and neither Dockerfile exports it past the build layer, so do not add it to a Coolify variable set. The worker has no build-time import of its env at all.

Both processes log the resolved adapter names — names only, never hosts, keys or addresses — at server start: the worker's `worker started` line carries `adapters: { email, payments, uptime, ads, hosting, dns, cms }` (preceded by its `NODE_ENV=…` line and by one `WARN` per tolerated mock), and the web app logs the same set as `web adapters` when `register()` loads the env module. Check those lines after every redeploy; they are the cheapest way to notice a variable that did not survive one. `dns` reads `hostinger+cloudflare`, `hostinger`, `cloudflare` or `mock`; `ads` reads `google+meta`, `google`, `meta` or `mock`.

### Real adapters and their keys

Every adapter is mock-first and constructs without touching the network, so a wrong credential fails on first use, not at boot. What each key selects, and where it comes from:

| Adapter | Keys | Real when | Where the key comes from |
|---|---|---|---|
| **hosting** (Coolify) — `hosting_get_resources` for the Hosting Guard-Dog | `COOLIFY_API_URL`, `COOLIFY_API_TOKEN`; optional `COOLIFY_SERVER_UUID`, `COOLIFY_TIMEOUT_MS` | both set | URL: the Coolify instance root, e.g. `https://coolify.launchflow.co.uk` (`/api/v1` is appended; a non-http(s) value is a boot refusal). Token: Coolify → **Keys & Tokens → API tokens → Create New Token**, scoped to the team owning the applications — read is enough for diagnosis. **Settings → API** must be enabled on the instance and the caller's IP allowed, or a valid token still gets 401. `sites.hosting_ref` holds the application uuid (`GET /api/v1/applications` lists them). Note `metricsAvailable: false` in a result means CPU/memory/disk are *unknown*, not idle — not every 4.x build publishes them |
| **dns** (Hostinger + Cloudflare, per domain) — `dns_update_record` | `HOSTINGER_API_TOKEN`, `CLOUDFLARE_API_TOKEN` | independently: a token makes the zones whose `domains.dns_provider` names that provider real; the other provider's zones stay on its mock, and `registrar` / `other` domains always do | Hostinger: hPanel → account menu (top right) → **API** → *Generate new token*, DNS scope; shown once, looks like `hpat_…`. Cloudflare: dash.cloudflare.com → **My Profile → API Tokens → Create Token** → *Edit zone DNS* template, or custom with **Zone → DNS → Edit** plus **Zone → Zone → Read** (required — zones are looked up by name), *Zone Resources* restricted to the zones LaunchFlow manages. An API **token**, not the Global API Key (that authenticates with `X-Auth-Key`; this client sends a bearer). Before the first live Hostinger change, verify on a throwaway zone that a PUT with `overwrite: false` replaces the named record set rather than appending |
| **cms** (WordPress, per-site credentials) — `cms_update_content`, Websites → WordPress connection | `SECRETS_ENCRYPTION_KEY` | set | 32 random bytes, base64: `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`. It encrypts each site's WordPress application password at rest (AES-256-GCM, `site_credentials`); the password itself is entered per site on its website page: WordPress → **Users → Profile → Application Passwords → Add New** (name it `LaunchOS`, copy the six-group value once), needs WordPress 5.6+, HTTPS and `/wp-json` reachable — Wordfence "disable REST API" and hosts that strip the `Authorization` header are the usual reasons the Test button reports `rest_no_route` or a 401. **Rotating the key makes every stored credential unreadable** (`SecretsDecryptError` on read): each site's password must be re-entered. There is no plaintext fallback |
| **ads** (Google Ads + Meta Ads, by credential) — ads ingest, Ad Performance Sentinel | Google: `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` (+ optional `GOOGLE_ADS_API_VERSION`, default `v25`). Meta: `META_ADS_ACCESS_TOKEN`, `META_ADS_APP_SECRET` (+ optional `META_ADS_API_VERSION`, default `v26.0`; `META_ADS_CONVERSION_ACTIONS`) | per platform, all of its keys; both platforms → the `multi` router; a half-set platform is refused | **Google.** Developer token: sign in to the *manager* account (create one at ads.google.com/home/tools/manager-accounts if needed) → **Tools & Settings → Setup → API Center** → apply ("internal reporting for our own managed client accounts"); the token works against test accounts at once and needs *Basic Access* (a few working days) for live ones. Client id/secret: console.cloud.google.com → enable **Google Ads API** → OAuth consent screen (External, add yourself as a test user, then publish so refresh tokens stop expiring after 7 days) → **Credentials → OAuth client ID → Desktop app**. Refresh token: developers.google.com/oauthplayground → gear → *Use your own OAuth credentials* → add `https://developers.google.com/oauthplayground` as an authorised redirect URI on the client → scope `https://www.googleapis.com/auth/adwords` → authorise as the account with manager access → exchange code → copy the `1//…` refresh token. Login customer id: the manager account number top-right in the Ads UI, dashes optional. **Meta.** developers.facebook.com/apps → Create app (Business) attached to your Business Manager → **App settings → Basic → App secret**; add the **Marketing API** product. Token: business.facebook.com/settings → **Users → System users → Add** (Employee) → *Add assets*: the app (Manage app) and every client ad account (View performance) → **Generate new token** with `ads_read` + `read_insights`, expiry **Never**; shown once. Turn on *Require app secret* under App settings → Advanced. No app review while reading ad accounts your own business owns — have clients share their account into your Business Manager rather than reading it from theirs. Per-account ids are `ad_accounts.external_id`, not env. Before the first client report, run one day against a live account and check which `action_type`s it returns; set `META_ADS_CONVERSION_ACTIONS` if the defaults miss the client's conversion |

None of the four has been run against a live endpoint yet — every test is against recorded fixtures. Wire one, run one real call (a `hosting_get_resources` on a known ref, a Test button press, one day of ads ingest), and read the payload before trusting the numbers.

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

**Real, but unset until their keys are:** ads (Google / Meta), hosting (Coolify), DNS (Hostinger / Cloudflare) and CMS (WordPress) all have a real client now, selected by the keys in *Real adapters and their keys* above. Until a key is set the corresponding mock answers, production tolerates it with a startup warning, and:

- `TWILIO_*` are still **placeholders**. Nothing reads them.
- `dns_update_record` and `cms_update_content` are approval-gated tools. Their approval cards read the provider name off the adapter that will really run at describe time — for DNS, the per-domain half the registry resolves to — and print a line naming the mock and stating that nothing reaches the zone or the CMS until a real provider is configured, so nobody approves one expecting a page to change. The row, the audit entry and the run trace are written the same way either way.

## Branch flow

`main` is production. Feature work happens on branches locally, is tested against docker Postgres, and merges to `main` only after Shoji approves. Coolify deploys `main`.
