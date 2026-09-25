# Infrastructure: Hetzner servers + Coolify apps in LaunchOS

Date: 25 Sep 2026. Status: approved in chat, not built.

## Why

Every LaunchFlow app runs on a Hetzner Cloud server with its own Coolify. Today
LaunchOS knows none of it: the only trace is one hand-typed "Hetzner — server"
line in the cost register. Shoji checks two Hetzner accounts and ten Coolify
dashboards by hand, and the servers' cost reaches Profit only if he types it.

This brings them into one screen: every server, what runs on it, what it costs
this month, and the everyday actions — without leaving LaunchOS.

## What exists today (25 Sep 2026)

Two Hetzner Cloud accounts, ten servers, all `eu-central`, each with its own
Coolify:

| Account | Servers |
|---|---|
| A (6) | LaunchFlowPAK (CPX32), GraysCabLine (CX23, Helsinki), AgentZero (CX23), LakesideTaxis (CX23), BIZZFLOWUK (CX23), CABIOMASTER (CPX32, delete-protected) |
| B (4) | CueMaster (CX23), PizzaParlour (CX23 + 100 GB volume), LaunchFlowECOM (CX23), LaunchFLOWUKLIMITED (CX33 + 100 GB volume) |

Account A has three servers in Falkenstein, two in Nuremberg and one in
Helsinki (GraysCabLine).

Two volumes are attached, so volume cost is not optional.

### Verified against the live API (25 Sep 2026, read-only)

The formula below, run over both accounts, gives **€145.33/month** (account
with CABIOMASTER €103.04, the other €42.29). Every server is running; traffic
is under 10 GB of a 22 TB allowance, so overage is theoretical today.

Shape facts the build must follow (they differ from older API docs):

- The server's location is `server.location.name` (`fsn1`, `nbg1`, `hel1`).
  There is **no `datacenter`** on the server object any more.
- Prices are per location in `server_type.prices[]`, as decimal **strings**
  (`"8.4900000000"`). Parse them to integer cents at the boundary, never floats
  in totals.
- `pricing.vat_rate` and `gross == net` on these accounts confirm the reverse
  charge.
- Every server has one primary IPv4 at €0.50/month. IPv6 is free and is not
  in `pricing.primary_ips`.
- Backups are on for only four servers (LaunchFLOWUKLIMITED, LaunchFlowECOM,
  PizzaParlour, CABIOMASTER). The screen should make "no backups" visible.

`.env` currently holds the two tokens as two lines both named
`HETZNER_API_TOKENS`, so any env loader keeps only the second. This build does
not read them from env. They are entered once through Settings → Infrastructure
and then removed from `.env`.

## Decisions

1. **Hetzner Cloud only.** No Robot/dedicated adapter until a dedicated box exists.
2. **Cost = per server, tagged to a business.** No split across apps.
3. **Any number of connections, stored in the database.** Not env vars — adding
   a server must not need a redeploy. `provider` is an enum so a new host is a
   new value plus an adapter; none are built speculatively.
4. **Everyday actions only.** Delete, rebuild and rescale stay in the Hetzner
   console: they destroy data or cause downtime and are rare.
5. **No agent touches infrastructure.** No agent tool in this build.
6. **Owner only.** Connections, server screen and actions require role `owner`.

## Data

### `infra_connections`

| Column | Notes |
|---|---|
| tenant columns | `organisation_id` etc. from `_shared.ts` |
| `provider` | enum `infra_provider`: `hetzner_cloud`, `coolify` |
| `label` | Shoji's name: "Hetzner — account A", "Coolify — CABIOMASTER" |
| `base_url` | Coolify only. Hetzner is always `https://api.hetzner.cloud/v1` |
| `token_encrypted` | via `packages/core/src/secrets/encryption.ts`. Never returned to the browser after save |
| `server_id` | Coolify only, nullable FK → `servers`. Which box this Coolify runs on |
| `last_synced_at`, `last_error` | per-connection health; one bad token never stops the others |

### `servers`

One row per Hetzner server, upserted by the sync on `(organisation_id, connection_id, hetzner_id)`.

| Column | Notes |
|---|---|
| `connection_id` | FK → `infra_connections` (the Hetzner account) |
| `hetzner_id`, `name`, `server_type`, `location`, `ipv4`, `status` | from the API, verbatim |
| `delete_protected`, `backups_enabled` | `protection.delete`, `backup_window != null` |
| `included_traffic_bytes`, `outgoing_traffic_bytes` | for the traffic bar and overage |
| `business` | `cost_business` enum, **set by a human**, never by the sync. Default `shared` |
| `metrics` | jsonb: last 24 h of CPU % and disk IOPS, ~96 points, written at sync |
| `cost` | jsonb: the breakdown below, in EUR cents, written at sync |
| `pending_action` | jsonb `{ id, command, startedAt }` or null |
| `seen_at` | a server deleted in Hetzner stops being seen; shown as "gone", not deleted |

### Apps

Coolify apps are **not stored**. The Servers screen fetches them live from each
Coolify connection. There are ten small calls, run in parallel with a 5 s timeout
each, and a failed Coolify shows "unreachable" on its row. If this gets slow,
the upgrade is to store them at sync.

## Cost: what one server costs this month

All from Hetzner's own API, in EUR, **net** (ex-VAT). Hetzner bills this
business under the reverse charge. The sources are `server_type.prices` for the
server's location and `GET /pricing` for everything else.

```
base       = min(price_hourly × hours_since_max(month_start, created), price_monthly)
backups    = base × pricing.server_backup.percentage / 100        if backups_enabled
volumes    = Σ volume.size_gb × pricing.volume.price_per_gb_month  (attached to it)
primary_ip = Σ primary IPv4 monthly price                          (assigned to it)
snapshots  = Σ image_size_gb × pricing.image.price_per_gb_month    (created_from it)
traffic    = max(0, outgoing − included) in TB × price_per_tb_traffic
```

Both **month to date** and **projected full month** (base at `price_monthly`)
are stored. A snapshot whose source server is gone is costed on an
account-level line.

**Into the register.** The sync upserts one `supplier_costs` row per server:
`supplier = hetzner`, `source = sync`, `external_id = "<connection>:<hetzner_id>"`,
`currency_code = EUR`, `vat_treatment = reverse_charge`, `billing_period_unit =
month`, `renewal_price` = projected month in cents, and `business` copied from
`servers.business`. It follows the Hostinger sync's rule: a synced row's money
cannot be edited or deleted. Its business is set on the Servers screen, not in
the register. When the first Hetzner connection syncs, the hand-typed "Hetzner —
server" row is left alone. The register screen then flags it as a likely
duplicate for Shoji to delete himself.

**£** comes from `fx_rates`. A missing rate is never 1.0: the screen shows €
only and names the missing rate, the same as Profit does today.

**Honest ceiling:** these are list prices, not the invoice. Hetzner's API has no
invoices. Reconciling against the monthly PDF is out of scope.

## Sync

pg-boss cron `infra.sync`, every 15 minutes, Europe/London.

For each Hetzner connection: `GET /servers`, `/volumes`, `/primary_ips`,
`/images?type=snapshot`, `/pricing` (once per run), and
`/servers/{id}/metrics?type=cpu,disk` for the last 24 h. Then it upserts
`servers` and `supplier_costs` and settles any `pending_action` via
`GET /actions/{id}`.

Coolify connections are tested for reachability only (`GET /api/v1/version`).
Each connection updates its own `last_synced_at` / `last_error` inside its own
try/catch.

Rate limit: Hetzner allows 3600 requests an hour per project. Ten servers ×
(1 metrics + shared calls) × 4 runs an hour is well under 100.

## Screens

### Settings → Infrastructure

A table of connections with provider, label, linked server (Coolify), last sync
and error. Add/Edit opens a form. **Test** calls the API with the typed token
before saving; a failure is shown and nothing is saved. When a Coolify
connection is added, its URL host is resolved (`dns.lookup`) and matched to a
server's IPv4 as a suggestion; Shoji can change it. Remove deletes the
connection. Its servers stay as "gone" history, and their cost rows stay but
stop updating.

### Servers (`(admin)/servers`, in the main nav)

KPI strip: month-to-date £, projected month £, server count, anything
unhealthy (not running, sync error, Coolify unreachable, traffic > 80%).

A full-bleed table, grouped by Hetzner account:

- name + type + location, status dot, lock icon if delete-protected
- business (inline select, audited)
- CPU sparkline, traffic bar (used / included)
- month to date and projected, in £ (€ underneath)
- apps: Coolify app names with status dots, linking to that Coolify
- actions menu

A row expands to the cost breakdown line by line.

### Actions

| Action | Hetzner call | Confirmation |
|---|---|---|
| Reboot | `POST /servers/{id}/actions/reboot` (ACPI) | type the server name |
| Shut down | `…/shutdown` (ACPI, graceful) | type the server name |
| Power on | `…/poweron` | plain confirm |
| Take snapshot | `…/create_image {type: snapshot, description}` | plain confirm, shows the monthly cost |
| Backups on / off | `…/enable_backup` / `disable_backup` | plain confirm, shows the +20% |
| Redeploy app | Coolify `GET /api/v1/deploy?uuid=` | plain confirm |

Each action is a server action: owner check, Zod input, call, store
`pending_action`, write `audit_log` (actor, server, command, Hetzner action id).
The row shows "Rebooting…" until the sync or the next page load settles it.
Hard power-off/reset is deliberately absent — shut down is the safe one.

## Code layout

```
packages/db/src/schema/infrastructure.ts        infra_connections, servers, enum
packages/integrations/src/infra/                hetzner.ts, coolify-instance.ts (the existing single-server Coolify adapter stays as it is)
packages/core/src/infrastructure/
  connections.ts      create / test / update / remove (encrypts)
  cost.ts             pure cost maths — no I/O
  sync.ts             one run across all connections
  actions.ts          server + app actions, audited
apps/worker/src/jobs/infra-sync.ts
apps/web/src/app/(admin)/servers/…
apps/web/src/app/(admin)/settings/infrastructure/…
```

Real vs mock: a connection whose token starts `mock_` uses the mock client, so
tests and the local demo need no real account.

## Tests

- `cost.ts`: prorating at month start, mid-month creation, cap at the monthly
  price, backups %, volumes, traffic overage, snapshot of a gone server.
- `sync.ts` against the mock: upsert, disappearance, one failing connection
  does not stop the rest, `supplier_costs` row shape, and business never
  overwritten.
- `connections.ts`: the token is encrypted at rest and never returned; Test
  failure saves nothing; tenancy filter.
- `actions.ts`: non-owner refused, audit row written, `pending_action` set.
- One Playwright pass: add a mock connection, see servers, reboot one.

## Build order

1. Schema + connections + Settings → Infrastructure.
2. Hetzner client/mock + cost + sync + register rows.
3. Servers screen + server actions.
4. Coolify apps + redeploy.

Local first. Nothing is pushed until Shoji says.

## Needs from Shoji

- Hetzner: done. Both Read & Write tokens exist and work.
- Coolify: each Coolify's URL and an API token (Coolify → Keys & Tokens), when
  chunk 4 starts. All of them are entered through the Settings screen.
