# LaunchOS

Agency operating system for LaunchFlow: hosting, web design and ad management, with a management portal, a client support portal, two-way communication and autonomous AI sub-agents.

Status: **architecture locked, foundation plan written, no application code yet.** See `docs/superpowers/plans/` for the build plan and `CLAUDE.md` for workspace rules.

## Quick start (once Plan 1 is executed)

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm db:migrate
pnpm db:seed
pnpm dev          # http://localhost:3000
pnpm dev:worker   # second terminal
```

## Docs

- `CLAUDE.md` — workspace rules and stack
- `docs/ARCHITECTURE.md` — runtime shape, request and job flow
- `docs/DATA_MODEL.md` — tables and relationships
- `docs/AGENT_FRAMEWORK.md` — agent kernel, tools, policy gate, the three agents
- `docs/MODULE_MAP.md` — admin and portal modules, v1 vs later
- `docs/DEPLOYMENT.md` — local, Coolify, environment
- `docs/superpowers/specs/2026-09-03-agency-os-design.md` — the design spec
- `docs/superpowers/plans/2026-09-03-foundation-and-hosting-guard-dog.md` — Plan 1
