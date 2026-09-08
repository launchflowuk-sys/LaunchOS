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
| `@launchflow/ui` | `cn`, `Category`, `CATEGORY_TEXT`, `CATEGORY_DOT` |

Primitives, composites and the admin shell are still being extracted from
LaunchOS. See `docs/superpowers/specs/2026-09-08-launchflow-ui-design-system-design.md`
for the phase order.

## Development

LaunchOS consumes this as `workspace:*`, so it is the proving ground: a change
here is validated against real screens before it reaches another project. There
is deliberately no Storybook.
