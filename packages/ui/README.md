# @launchflow/ui

The LaunchFlow design system: tokens, primitives and components for admin
portals and client-facing apps.

**The specification is [DESIGN.md](./DESIGN.md)** — read it before adding
anything. Its "Never" list is the valuable part: every line was added after that
exact mistake shipped once.

## Install

```bash
pnpm add @launchflow/ui
```

In the app's root stylesheet, replacing any `@import "tailwindcss"` (this
package imports Tailwind itself):

```css
@import "@launchflow/ui/styles";
```

Requires Tailwind 4 — the tokens live in `@theme inline`, which Tailwind 3
cannot read.

## What is here

| Entry | Contents |
|---|---|
| `@launchflow/ui/styles` | Tokens, base layer, component layer |
| `@launchflow/ui` | Everything below, re-exported, plus `cn` and the category hues |
| `@launchflow/ui/ui/<name>` | 24 primitives — button, input, dialog, select, sheet, table, … |
| `@launchflow/ui/components/<name>` | StatCard, DataList, Panel, PageHeader, StatusBadge, EmptyState, Toolbar, KeyValue, InlineAlert |
| `@launchflow/ui/components/app-nav` | The navy rail and its mobile sheet |
| `@launchflow/ui/components/portal/<name>` | PortalTabs, PortalForm, PortalStatus, PortalSelect, PortalProgress, MessageThread, PrintButton |
| `@launchflow/ui/lib/format` | formatDateTime, formatMoney, formatDate, formatDuration |
| `@launchflow/ui/styles/marketing`, `/styles/motion` | The public-site CSS |

**This is a Next.js design system.** `next` is a peer dependency: StatCard and
Panel use `next/link`, and the composites are server components. Do not wrap
them in a context provider — that pushes them across the client boundary and
ships JavaScript for a static card.

The rail is bound inside a **client** component: `NavItem.icon` holds a Lucide
component, and a component reference cannot cross the RSC boundary.

## Development

LaunchOS consumes this as `workspace:*`, so it is the proving ground: a change
here is validated against real screens before it reaches another project. There
is deliberately no Storybook.
