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
     - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`
     - `INBOUND_EMAIL_SECRET`
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
   - Env vars: `DATABASE_URL` (same as web), `ANTHROPIC_API_KEY`, `AGENT_MODEL`, `LLM=anthropic`, `AGENT_POLICY=safe`, `UPTIME_PROBE=http`.
   - Keep the worker at a **single replica**. The monitor sweep is not safe to run concurrently: two workers would double-count consecutive failures and open duplicate incidents.

5. **First owner account** — sign-up is disabled in the app (`emailAndPassword.disableSignUp`), so seeding is the only way to create the first account. Run the seed once, inside the running web container:

   ```bash
   docker exec <web-container> pnpm --filter @launchos/db seed
   ```

   Set `SEED_OWNER_PASSWORD` in the web resource's environment variables before running it, then **remove that variable and redeploy** once you have signed in. The seed refuses to run when `NODE_ENV=production` and `SEED_OWNER_PASSWORD` is unset, so it can never install the default development password in production. The seed is idempotent; re-running it will not change an existing password.

6. **Verify** — after first deploy, hit `https://os.launchflow.co.uk/api/health` and confirm `{"ok":true}`, then check the worker resource logs for the `worker started` line.

## Branch flow

`main` is production. Feature work happens on branches locally, is tested against docker Postgres, and merges to `main` only after Shoji approves. Coolify deploys `main`.
