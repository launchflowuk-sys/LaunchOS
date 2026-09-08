# LaunchOS — design system

Committed world: **the agency control room**. A confident, colourful-where-it-counts SaaS product: a **dark workspace** on the logo's navy, saturated KPI panels carrying the headline figures, one strong LaunchFlow blue for actions, and a fixed vocabulary of state colours so "needs you" is never mistaken for "fine". Operate mode throughout. Familiar SaaS conventions on purpose; personality lives in precision and colour discipline, not decoration.

**The workspace is dark and the public site is light. That split is deliberate and is not a bug to be tidied up.** A stranger meeting launchflow.co.uk should find something calm, white and professional; a person running their agency inside the admin for eight hours should not be stared at by a white page. The two never touch: the marketing site re-points every token under `.marketing` (`site/marketing.css`), so changing `:root` cannot reach it. The admin and the client portal share `:root` and get the same treatment as each other.

The previous look (default shadcn greys, serif fallback font, bare tables) is the anti-reference. So is the indigo the palette was guessed at before the logo was sampled.

## Brand

The logo is `docs/Logo.webp`; the app serves PNG copies from `apps/web/public/brand/` (`launchflow-logo.png` 300×72, `launchflow-logo@600.png` 600×144). Sampled from it: "Launch" and the swoosh run sky blue `#1090E0` → cyan `#10C0E0`, "Flow" is near-navy `#101020`. Every colour below that is not a state or a category is derived from those three.

The wordmark appears in exactly three places — the admin rail header, the portal top bar, `/sign-in` — through one component, `src/components/brand-mark.tsx`, at ~120px wide (96px in the portal bar, 160px on `/sign-in`), always `next/image` on the 600px source. **The asset is not transparent**: it carries an opaque near-white ground, so it sits on white or off-white surfaces only. On the navy rail it goes inside `BrandTile`, a white chip. Nowhere else in the product carries a logo; the footers still say "Powered by LaunchFlow" in text.

## Tokens

Declared in `src/app/globals.css` as CSS variables, exposed to Tailwind through `@theme inline`. The workspace is dark; the rail is darker still, so it stays a distinct plane rather than dissolving into the page.

Every ratio below is **calculated, not estimated** — `oklch` converted to sRGB and run through the WCAG formula, the same bar the light palette was held to.

| Token | Value | Use |
|---|---|---|
| `--background` | `oklch(0.185 0.02 264)` = `#0e131c` | workspace ground |
| `--card` | `oklch(0.225 0.021 263)` = `#171c26` | panels above the ground; foreground on it **15.46:1** |
| `--foreground` | `oklch(0.965 0.004 260)` | ink |
| `--muted-foreground` | `oklch(0.74 0.018 260)` | secondary text (**7.42:1** on card) |
| `--border` | `oklch(0.32 0.02 261)` | hairlines (1.35:1 on card — an edge, not a shout) |
| `--input` | `oklch(0.36 0.022 261)` | field borders, a touch brighter: a field has no fill, so its border is the only way to find it |
| `--primary` | `oklch(0.56 0.14 245)` = `#037ac0` | the one action colour. White on it **4.61:1**, and it stands off the card at 3.71:1. Solid and opaque — never a translucent pill |
| `--primary-soft` | `oklch(0.3 0.06 245)` | selected rows, pressed states |
| `--brand-cyan` | `oklch(0.75 0.13 216)` = `#18C2E2` | the swoosh's cyan. **8.00:1 on a card**, so unlike the light palette it may now carry text. It is also `--ring` |
| `--success-solid` | `oklch(0.52 0.14 155)` | the *approve* button. `--success-fg` is far too bright to carry a white label (2.2:1); this clears **5.09:1** |
| `--sidebar` | `oklch(0.145 0.022 265)` | the rail — the darkest surface in the product |
| `--ring` | `--brand-cyan` | focus, everywhere. The light palette had to ban cyan here at 2.14:1 on white; on dark it is the clearest thing available |
| `--radius` | `0.75rem` | cards; controls use `--radius-md` (0.5rem); pills full |

KPI grounds — the filled panels a `StatCard` wears. Each carries a white figure with room to spare:

| Token | Value | White on it |
|---|---|---|
| `--kpi-slate` | `oklch(0.26 0.03 262)` | 15.55:1 |
| `--kpi-blue` | `oklch(0.45 0.15 250)` | 7.35:1 |
| `--kpi-indigo` | `oklch(0.42 0.16 275)` | 8.92:1 |
| `--kpi-violet` | `oklch(0.44 0.2 300)` | 8.65:1 |
| `--kpi-teal` | `oklch(0.45 0.09 190)` | 6.97:1 |
| `--kpi-danger` | `oklch(0.45 0.18 25)` | 8.18:1 |
| `--kpi-warning` | `oklch(0.46 0.12 70)` | 7.29:1 |

**Support is indigo, not amber, and amber means warning and nothing else.** A ground deep enough to carry white cannot be a vivid amber — it lands on brown — and the brown then sat beside the warning ground looking identical to it.

Semantic (each a `-bg`, `-fg`, `-border` trio, every `-fg` AA on `--card`). The `-bg` values are dark tints of their own hue, not the pale washes the light palette used — a pale wash on a dark ground is a glare:

| State | fg | bg |
|---|---|---|
| success | `oklch(0.72 0.16 155)` — 7.38:1 | `oklch(0.27 0.06 155)` |
| warning | `oklch(0.78 0.15 75)` — 8.37:1 | `oklch(0.29 0.06 75)` |
| danger | `oklch(0.66 0.19 25)` — 5.03:1 | `oklch(0.28 0.08 25)` |
| info | `oklch(0.7 0.14 245)` — 6.47:1 | `oklch(0.27 0.06 245)` |

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

- Admin rail header: the wordmark on its white chip, "Admin portal" beneath it. The current nav item carries a 2px cyan marker on its left edge as well as the active pill — the pill alone is 1.38:1 against the rail, which is a surface, not a signal.
- Admin: rail 256px (`lg+`), collapses to a sheet under `lg` opened by a menu icon in a sticky top bar. Workspace `max-w-6xl`, padding `px-4 py-5` on mobile, `px-8 py-8` on desktop. Every flex/grid child that can hold a table gets `min-w-0`.
- Portal: sticky top bar with the wordmark, a rule, the client name, and a horizontally scrolling tab row (never wrapping to three lines), `max-w-5xl`, `px-4` mobile.
- Page header: title, one-line description, actions on the right; under `sm` the actions row wraps below and primary action becomes full width.
- Toolbar (filters/search): a wrapping row of controls with labels above; under `sm` each control is full width.
- Sections are separated by space and headings, not nested cards. A card marks a surface (table, form, thread), not a paragraph.

## Components (single source: `src/components`)

- **Button** (`ui/button`): `primary` (indigo), `secondary` (white, border), `ghost`, `destructive` (solid danger — the one decisive destructive action on a screen: archive this client, void this invoice), `destructive-quiet` (bordered, danger ink — the same action repeated once per row of a list: remove a contact, deactivate a member, suspend portal access), `success` (approve actions), sizes `sm | md | lg | icon`; every variant has hover, focus ring, disabled and loading (spinner replaces icon, label stays).
- **BrandMark / BrandTile** (`brand-mark.tsx`): the wordmark, and the wordmark on a white chip for dark surfaces. The only two ways a logo enters a screen.
- **StatusBadge**: pill with a leading dot, colour from the semantic map; value text humanised. Same component in admin and portal.
- **PageHeader** with category accent dot; **EmptyState** with a lucide icon, one sentence, optional primary action.
- **DataList**: the one way to show rows. Renders a real `<table>` inside `overflow-x-auto rounded-xl border bg-card` at `md+`; under `md` renders stacked row cards from the same column definitions (primary column as card title, status pill top-right, remaining columns as label/value pairs, row action as a full-width link). Nothing may overflow the viewport.
- **StatCard**: a headline figure as a **filled panel** — the whole surface is the category hue and the figure sits on it in white. On a dark workspace a card differs from the page by a shade and a hairline, so a coloured *detail* disappears; the colour had to become the surface. `attention` with a non-zero value abandons the category for the danger (or warning) ground and a "Needs you" pill; a zero falls back to slate, because a bright 0 reads as data when it is the absence of it. Not dashboard-only any more: any panel with a figure worth reading across the room may use it.
- **Toolbar / FilterBar**, **KeyValue** (label/value rows for detail pages), **Section** (heading + description + content), **Skeleton** rows for loading, **Alert** for inline warnings (send failed, access revoked).
- Forms use shadcn `Input`, `Select`, `Textarea`, `Label` everywhere; no bare `<input>` with ad-hoc classes. **A field is a border and nothing else** — no fill, no shadow, no plate floating on the page. Focus takes `--ring` (the brand cyan) on the border and a soft ring around it.
- Icons: lucide, 16px in buttons and nav, 20px in empty states, `stroke-width 1.75`.

## States that must be visible at a glance

Pending approval (warning pill + count badge in the rail), overdue (danger), unassigned (warning), client waiting (info), incident open (danger), invoice overdue (danger), send failed (danger alert on the row and the detail).

## Motion

150–200ms colour/opacity transitions on interactive elements; sheet and dialog use the library defaults; nothing else moves. Respect `prefers-reduced-motion`.

## Printing

The workspace is dark; paper is not. `globals.css` re-points the tokens inside `@media print` to the light palette this product used before, so every screen prints as ink on white without a single component knowing it is being printed. KPI panels drop their fill for a hairline there too — a solid block of colour is a page of wasted ink. Anything added that hardcodes a colour instead of reading a token will print wrong, and that is the main reason not to hardcode one.

## Never

Gradient text, eyebrows above headings, nested cards, coloured left borders thicker than 1px, emoji as icons, serif anywhere, tables that scroll the page body sideways, three-row wrapped navs, the logo on a coloured or dark ground without its white chip, a translucent "glass" pill where a solid button belongs, a field with a background fill, white cards floating on grey with shadows, `--success-fg` as a button ground (2.2:1 under a white label — use `--success-solid`), a second "dark mode" (the workspace *is* dark; the light one is the public site and it has its own palette).
