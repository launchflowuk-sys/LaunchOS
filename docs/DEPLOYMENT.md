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

Tests: `pnpm test` needs the docker Postgres running. Integration tests use `DATABASE_URL_TEST` if set, otherwise `DATABASE_URL` with a `launchos_test` database that the test setup creates.

## Production (Coolify on Hetzner)

Three Coolify resources in one project, all on the same internal network:

1. **postgres** — Coolify managed PostgreSQL 17 with a persistent volume and daily backups to Hetzner storage box. Not exposed publicly.
2. **web** — Docker build from `infra/Dockerfile.web`. Domain `os.launchflow.co.uk` (or chosen). Health check `GET /api/health`.
3. **worker** — Docker build from `infra/Dockerfile.worker`. No public port. Health check is the process itself.

Both app resources auto-deploy from `main` on GitHub push. Migrations run as the web container's entrypoint (`pnpm db:migrate && next start`) so the schema is always applied before serving. The worker waits for the web health check before starting.

Environment variables are set in Coolify, never committed. `NODE_ENV=production`, `APP_URL`, `BETTER_AUTH_URL` and `DATABASE_URL` point at the internal Postgres hostname.

## Branch flow

`main` is production. Feature work happens on branches locally, is tested against docker Postgres, and merges to `main` only after Shoji approves. Coolify deploys `main`.
