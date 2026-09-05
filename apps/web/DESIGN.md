# LaunchOS — design system

Committed world: **the agency control room**. A confident, colourful-where-it-counts SaaS product: dark navy rail on the left, calm cool-white workspace, one strong indigo for actions, and a fixed vocabulary of state colours so "needs you" is never mistaken for "fine". Operate mode throughout. Familiar SaaS conventions on purpose; personality lives in precision and colour discipline, not decoration.

The previous look (default shadcn greys, serif fallback font, bare tables) is the anti-reference.

## Tokens

Declared in `src/app/globals.css` as CSS variables, exposed to Tailwind through `@theme inline`. Light only in the workspace; the sidebar is a dark surface by design.

| Token | Value | Use |
|---|---|---|
| `--background` | `oklch(0.985 0.004 250)` | workspace ground (cool off-white, never pure white) |
| `--card` | `oklch(1 0 0)` | content surfaces, tables, forms |
| `--foreground` | `oklch(0.21 0.02 262)` | ink |
| `--muted-foreground` | `oklch(0.49 0.02 262)` | secondary text (4.5:1 on white) |
| `--border` | `oklch(0.905 0.01 255)` | hairlines |
| `--primary` | `oklch(0.52 0.19 275)` | the one action colour (indigo); `--primary-foreground` white |
| `--primary-soft` | `oklch(0.95 0.03 275)` | selected rows, active nav on light, soft buttons |
| `--sidebar` | `oklch(0.235 0.035 262)` | navy rail; `--sidebar-foreground` `oklch(0.86 0.02 262)` |
| `--sidebar-active` | `oklch(0.32 0.05 268)` | active item pill on the rail |
| `--ring` | `--primary` | focus |
| `--radius` | `0.75rem` | cards; controls use `--radius-md` (0.5rem); pills full |

Semantic (each a `-bg`, `-fg`, `-border` trio, all AA on white):

| State | fg | bg |
|---|---|---|
| success | `oklch(0.42 0.13 155)` | `oklch(0.95 0.05 155)` |
| warning | `oklch(0.47 0.13 70)` | `oklch(0.96 0.06 85)` |
| danger | `oklch(0.48 0.19 25)` | `oklch(0.95 0.04 20)` |
| info | `oklch(0.45 0.15 245)` | `oklch(0.94 0.04 245)` |

Category hues, used for nav group markers, page-header accent dot and stat cards only (never for buttons):

| Group | hue |
|---|---|
| Delivery (Clients, Websites, Domains, Tasks) | blue `oklch(0.6 0.15 245)` |
| Support (Inbox, Cases, Incidents) | orange `oklch(0.66 0.16 50)` |
| Money (Payments, Invoices, Ads, Reports) | green `oklch(0.6 0.14 155)` |
| Automation (Approvals, Agents, Email, Knowledge) | violet `oklch(0.6 0.19 305)` |
| Organisation (Team, Settings, Billing, Packages, Templates) | slate `oklch(0.58 0.04 255)` |

## Type

One family: **Geist Sans** (already loaded via `next/font`; `--font-sans` must point at `--font-geist-sans`). Geist Mono for ids, amounts in tables, code.

Fixed rem scale, ratio ≈1.2: 12 (meta) · 13 (table body, labels) · 14 (body) · 16 (emphasised body) · 18 (card title) · 22 (page title) · 28 (dashboard numbers). Headings weight 600, tracking `-0.01em` from 18 up. Labels uppercase 11px, tracking `0.06em`, muted. Numbers in columns `tabular-nums`.

## Layout

- Admin: rail 256px (`lg+`), collapses to a sheet under `lg` opened by a menu icon in a sticky top bar. Workspace `max-w-6xl`, padding `px-4 py-5` on mobile, `px-8 py-8` on desktop. Every flex/grid child that can hold a table gets `min-w-0`.
- Portal: sticky top bar with client name and a horizontally scrolling tab row (never wrapping to three lines), `max-w-5xl`, `px-4` mobile.
- Page header: title, one-line description, actions on the right; under `sm` the actions row wraps below and primary action becomes full width.
- Toolbar (filters/search): a wrapping row of controls with labels above; under `sm` each control is full width.
- Sections are separated by space and headings, not nested cards. A card marks a surface (table, form, thread), not a paragraph.

## Components (single source: `src/components`)

- **Button** (`ui/button`): `primary` (indigo), `secondary` (white, border), `ghost`, `destructive` (solid danger — the one decisive destructive action on a screen: archive this client, void this invoice), `destructive-quiet` (bordered, danger ink — the same action repeated once per row of a list: remove a contact, deactivate a member, suspend portal access), `success` (approve actions), sizes `sm | md | lg | icon`; every variant has hover, focus ring, disabled and loading (spinner replaces icon, label stays).
- **StatusBadge**: pill with a leading dot, colour from the semantic map; value text humanised. Same component in admin and portal.
- **PageHeader** with category accent dot; **EmptyState** with a lucide icon, one sentence, optional primary action.
- **DataList**: the one way to show rows. Renders a real `<table>` inside `overflow-x-auto rounded-xl border bg-card` at `md+`; under `md` renders stacked row cards from the same column definitions (primary column as card title, status pill top-right, remaining columns as label/value pairs, row action as a full-width link). Nothing may overflow the viewport.
- **StatCard**: dashboard only — number, label, delta or hint, link, category colour on the number.
- **Toolbar / FilterBar**, **KeyValue** (label/value rows for detail pages), **Section** (heading + description + content), **Skeleton** rows for loading, **Alert** for inline warnings (send failed, access revoked).
- Forms use shadcn `Input`, `Select`, `Textarea`, `Label` everywhere; no bare `<input>` with ad-hoc classes.
- Icons: lucide, 16px in buttons and nav, 20px in empty states, `stroke-width 1.75`.

## States that must be visible at a glance

Pending approval (warning pill + count badge in the rail), overdue (danger), unassigned (warning), client waiting (info), incident open (danger), invoice overdue (danger), send failed (danger alert on the row and the detail).

## Motion

150–200ms colour/opacity transitions on interactive elements; sheet and dialog use the library defaults; nothing else moves. Respect `prefers-reduced-motion`.

## Never

Gradient text, eyebrows above headings, nested cards, coloured left borders thicker than 1px, emoji as icons, serif anywhere, tables that scroll the page body sideways, three-row wrapped navs.
