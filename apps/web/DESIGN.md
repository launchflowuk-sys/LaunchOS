# LaunchOS — design system

Committed world: **the agency control room**. A white page with one dark thing on it — the navy rail — and figures that carry real colour: saturated KPI panels with big bold numbers, then calm white surfaces underneath for everything that is *read*. One strong LaunchFlow blue for actions, and a fixed vocabulary of state colours so "needs you" is never mistaken for "fine".

Two anti-references, both learned the hard way:

- **The default shadcn look**: greys, serif fallback, bare tables, 12px labels, translucent pills that look identical to each other at a glance.
- **A dark workspace.** The rail is dark and the KPI cards are dark. *Nothing else is.* Panels, tables, forms and detail screens stay white, because they are read rather than glanced at, and a dark surface is worst at exactly that. Darkening the canvas because two elements are dark is the specific mistake this line exists to prevent.

## Brand

The logo is `docs/Logo.webp`; the app serves PNG copies from `apps/web/public/brand/` (`launchflow-logo.png` 300×72, `launchflow-logo@600.png` 600×144). Sampled from it: "Launch" and the swoosh run sky blue `#1090E0` → cyan `#10C0E0`, "Flow" is near-navy `#101020`. Every colour below that is not a state or a category is derived from those three.

The wordmark appears in exactly three places — the admin rail header, the portal top bar, `/sign-in` — through one component, `src/components/brand-mark.tsx`, at ~120px wide (96px in the portal bar, 160px on `/sign-in`), always `next/image` on the 600px source. **The asset is not transparent**: it carries an opaque near-white ground, so it sits on white or off-white surfaces only. On the navy rail it goes inside `BrandTile`, a white chip. Nowhere else in the product carries a logo; the footers still say "Powered by LaunchFlow" in text.

## Tokens

Declared in `src/app/globals.css` as CSS variables, exposed to Tailwind through `@theme inline`. Light only in the workspace; the sidebar is a dark surface by design.

| Token | Value | Use |
|---|---|---|
| `--background` | `oklch(1 0 0)` | workspace ground — **white**, deliberately the same as `--card` |
| `--card` | `oklch(1 0 0)` | content surfaces, tables, forms |
| `--foreground` | `oklch(0.21 0.02 262)` | ink |
| `--muted-foreground` | `oklch(0.49 0.02 262)` | secondary text (4.5:1 on white) |
| `--border` | `oklch(0.905 0.01 255)` | hairlines |
| `--primary` | `oklch(0.53 0.13 245)` = `#0A71B1` | the one action colour — the logo's sky-blue hue, darkened until white on it is **5.23:1**; `--primary-foreground` white |
| `--primary-soft` | `oklch(0.955 0.022 245)` = `#E4F2FE` | selected rows, active nav on light, soft buttons. `--primary` text on it is **4.60:1** |
| `--brand-cyan` | `oklch(0.75 0.13 216)` = `#18C2E2` | the swoosh's cyan. Highlights, the active rail marker, focus **on the rail** (8.48:1 there) |
| `--sidebar` | `oklch(0.2 0.03 265)` | the logo navy as a rail; `--sidebar-foreground` `oklch(0.86 0.02 262)` (11.85:1), `--sidebar-muted` `oklch(0.66 0.02 262)` (5.83:1) |
| `--sidebar-active` | `oklch(0.31 0.05 250)` | active item pill on the rail (white on it 13.13:1) |
| `--sidebar-ring` / `--sidebar-primary` | `--brand-cyan` | focus and the active marker on the rail |
| `--ring` | `--primary` | focus **on the workspace**. Never `--brand-cyan`: it is 2.14:1 on white |
| `--radius` | `0.75rem` | shadcn's base; **content surfaces do not use it** — see Geometry |
| `--kpi-navy` / `-cobalt` / `-purple` / `-teal` | `#0B1020` · `#2457FF` · `#7857FF` · `#0D6E63` | KPI card grounds. White on them: 18.93 · 5.41 · 4.56 · 6.13 |
| `--kpi-coral` / `--kpi-amber` | `#B3242F` · `#8A5200` | the alarm and warning grounds a KPI card switches to |

Every value above is inside the sRGB gamut and every ratio is calculated, not estimated. The obvious brighter reading of the logo — `oklch(0.55 0.16 235)` — is **not** in gamut; a browser clipping it lands on `#007CC0`, which is 4.51:1 against white, i.e. AA with 0.01 of headroom. Hence 0.53 / 0.13 / hue 245.

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

Fixed rem scale, declared as tokens in `globals.css`:

| Token | px | Use |
|---|---|---|
| `--text-label` | 12 | uppercase labels, tracking `0.06em`, muted |
| `--text-meta` | 13 | timestamps, hints, captions |
| `--text-row` | 15 | table rows and list bodies |
| `--text-sm` | 15 | body. **Tailwind's default 14 was the squint** and is overridden |
| `--text-figure` | 28 | a panel that leads with one number |
| `--text-title` | 32 | page title |
| `--text-kpi` | 44 | the figure on a KPI card |

Headings weight 600–700, tracking `-0.01em` from 18 up. Numbers in columns `tabular-nums`.

**A KPI figure sizes to its own length** (`figureSize` in `stat-card.tsx`): a card is 176px of usable width at four-up, and at 44px the digits run ~0.53em each, so anything past seven characters is clipped by the card's own `overflow-hidden`. "£1,544.40" wanted 207px of a 176px box and lost its last digits — on a money figure that is not cosmetic.

**Never `text-xs` for anything a person reads.** It is for shadcn chrome (avatar initials, dropdown labels, tooltips) and nothing else.

## Geometry and controls

One corner and one control height, everywhere. The drift this prevents is real:
a `NativeSelect` shipped at 32px with an 8px corner sitting directly beside a
48px input in every filter row, and 145 content boxes across 84 files were
still on a 12px corner while the panels and tables around them were on 20px.

| Thing | Corner | Height |
|---|---|---|
| KPI card (`StatCard`) | 22px | `min-h-39` |
| Content surface (`Panel`, `DataList`, any `border bg-card` box) | 20px | — |
| Field (`Input`, `NativeSelect`, `Textarea`, the global search) | 14px | **48px** |
| Button | 14px | `sm` 36 · `md` 44 · `lg` 48 |
| Pill / badge | full | — |

A button that sits in a row of fields is 48px, not 44 — `ToolbarActions`
enforces it. Four pixels out is exactly the near-miss that makes a row look
assembled rather than designed.

Fields are **transparent with a border**, never a grey well. The page is white;
a field that paints its own white on white is only its border, and the border
is the point.

## Layout

- Admin rail header: the wordmark on its white chip, "Admin portal" beneath it. The current nav item carries a 2px cyan marker on its left edge as well as the active pill — the pill alone is 1.38:1 against the rail, which is a surface, not a signal.
- Admin: rail 256px (`lg+`), collapses to a sheet under `lg` opened by a menu icon in a sticky top bar. Workspace `max-w-6xl`, padding `px-4 py-5` on mobile, `px-8 py-8` on desktop. Every flex/grid child that can hold a table gets `min-w-0`.
- Portal: a **white** 256px rail (`lg+`, a sheet below it) with the wordmark over "Client portal", nav grouped as Overview / Your websites / Your projects / Billing / Help & insights, and a `--primary-soft` "Need a hand?" card pinned at the bottom. A sticky bar carries the client's own name and initials chip on the left and the account menu on the right; `max-w-6xl` workspace.

  The rail is white, not the admin's navy: a client is a guest, the surface should read as their workspace rather than the inside of somebody else's tooling, and the one saturated thing on screen is the item they are standing on. This replaced a scrolling tab row — eleven tabs on one line was a row you scrolled to find anything, and it is the reason the earlier note here said a client portal should not have a sidebar.
- Page header: title, one-line description, actions on the right; under `sm` the actions row wraps below and primary action becomes full width.
- Toolbar (filters/search): a wrapping row of controls with labels above; under `sm` each control is full width.
- Sections are separated by space and headings, not nested cards. A card marks a surface (table, form, thread), not a paragraph.
- **No screen may scroll sideways at 375px, and this is asserted rather than remembered.** `tests/e2e/mobile-overflow.spec.ts` walks every admin route, six detail screens and every portal route at 375px and fails with the offending element named. It exists because a `Panel` shipped without `min-w-0`, a table inside it sized to its own content, and the whole shell became draggable left-to-right; typecheck cannot see layout and nothing else measured a viewport. It has since caught detail-page action rows that could not wrap.

## Components (single source: `src/components`)

- **Button** (`ui/button`): `primary` (indigo), `secondary` (white, border), `ghost`, `destructive` (solid danger — the one decisive destructive action on a screen: archive this client, void this invoice), `destructive-quiet` (bordered, danger ink — the same action repeated once per row of a list: remove a contact, deactivate a member, suspend portal access), `success` (approve actions), sizes `sm | md | lg | icon`; every variant has hover, focus ring, disabled and loading (spinner replaces icon, label stays).
- **BrandMark / BrandTile** (`brand-mark.tsx`): the wordmark, and the wordmark on a white chip for dark surfaces. The only two ways a logo enters a screen.
- **StatusBadge**: a **solid** pill — saturated ground, white label, no dot, no transparency. The translucent tinted pill it replaced could not be told from its neighbour at a glance, which is the entire job of a status. Same component in admin and portal.
- **PageHeader** with category accent dot; **EmptyState** with a lucide icon, one sentence, optional primary action.
- **DataList**: the one way to show rows. Renders a real `<table>` inside `overflow-x-auto rounded-[20px] border bg-card` at `md+`; under `md` renders stacked row cards from the same column definitions (primary column as card title, status pill top-right, remaining columns as label/value pairs, row action as a full-width link). Nothing may overflow the viewport.
- **StatCard**: a dark saturated panel on the white canvas — icon tile, label, big figure, hint, optional trend pill and sparkline. **Every list screen leads with a strip of four**, not just the dashboard; the portal leads with three. `attention` switches the ground to coral (or amber via `attentionTone`) when the figure is one that needs a person. The sparkline gets its own full-width row beneath the figure — beside it, it drew straight through the number.
- **Panel**: the white content surface under the cards. `min-w-0` is **not optional** on it (see Layout).
- **GlobalSearch**: the top bar's platform search — 48px, brand-tinted, the widest control in the shell. ⌘K/Ctrl+K focuses it from anywhere, arrows walk results across group boundaries, Enter opens the top hit, Escape closes. On a phone it takes a full-width row of its own under the bar.
- **Toolbar / FilterBar**, **KeyValue** (label/value rows for detail pages), **Section** (heading + description + content), **Skeleton** rows for loading, **Alert** for inline warnings (send failed, access revoked).
- Forms use shadcn `Input`, `Select`, `Textarea`, `Label` everywhere; no bare `<input>` with ad-hoc classes.
- Icons: lucide, 16px in buttons and nav, 20px in empty states, `stroke-width 1.75`.

## States that must be visible at a glance

Pending approval (warning pill + count badge in the rail), overdue (danger), unassigned (warning), client waiting (info), incident open (danger), invoice overdue (danger), send failed (danger alert on the row and the detail).

## Motion

150–200ms colour/opacity transitions on interactive elements; sheet and dialog use the library defaults; nothing else moves. Respect `prefers-reduced-motion`.

## Sign-in

No card, no shadow, no second ground. The wordmark sits bare on the page, the
heading is real text under it, the two fields are the only boxes on the screen,
and one full-width brand button finishes it. The two-factor step is identical
so the two halves of signing in do not look like two products.

It used to be a white rounded box with a shadow floating on an almost-white
page, with its fields overridden back to 44px on a card ground. That is the
pattern the "Never" list below now forbids by name.

## Never

Gradient text, eyebrows above headings, nested cards, coloured left borders thicker than 1px, emoji as icons, serif anywhere, tables that scroll the page body sideways, three-row wrapped navs, the logo on a coloured or dark ground without its white chip, `--brand-cyan` as a text or button colour.

And, added after each one shipped once:

- **A white rounded box with a shadow on a near-white page.** A shadow belongs to things that genuinely float — dropdown, popover, sheet, dialog, the search results panel — and to nothing that sits still on the page.
- **A dark workspace.** The rail and the KPI cards are the dark things. Everything read stays white.
- **A translucent status pill.** Solid ground, white label.
- **A control that disagrees with the control beside it** on height or corner. See Geometry.
- **`text-xs` on anything a person reads.**
- **A grid or flex child without `min-w-0` when it can hold a table.**
- **A custom font-size token in the same `cn()` as a text colour.** `tailwind-merge` cannot tell `text-kpi` or `text-meta` from `text-white`, so the colour wins and the size is silently dropped — a 44px figure renders at body size and nothing errors. Use an arbitrary length (`text-[2.75rem]`) wherever a size and a colour meet. This has shipped twice.
- **A JSX comment inside `actions={…}` or a ternary branch.** Both take a single expression; a comment there is a parse error, and it has broken the build more than once. Put the note above the expression.
