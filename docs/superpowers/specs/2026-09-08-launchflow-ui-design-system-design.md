# LaunchFlow UI — the design system as a package

**Date:** 8 September 2026
**Status:** design agreed, awaiting spec review
**Supersedes:** the placeholder README in `packages/ui`

## The problem

The LaunchOS design system is good and it is trapped. `apps/web/DESIGN.md` holds
160 lines of decisions with calculated contrast ratios and a "Never" list where
every entry was added after that exact mistake shipped once. `globals.css` holds
328 lines of tokens. Sixty-two component files build on them.

None of it can leave this repo. When Thurrock Tuition Academy gets an admin
screen it starts from bare shadcn — grey, serif fallback, 12px labels, the
anti-reference DESIGN.md names in its second paragraph. Every new project re-pays
a cost that was already paid here, and pays it badly.

Shoji's ask, in his words: *"the LaunchOS backend is the standard backend design
from day one regardless of whichever app I build, whatever new project I start —
if it contains a backend it should have this design."*

## What we are building

Two things, because the ask needs both:

1. **`@launchflow/ui`** — a public npm package holding the tokens, the
   primitives, the composites, the admin shell, the portal components and the
   marketing CSS. This is the code.
2. **A user-scope Claude Code skill** at `~/.claude/skills/launchflow-design/` —
   fires in any project, tells Claude to install the package and hands it the
   rules and the Never list. This is the reflex.

The package without the skill is passive: it sits on the registry and nothing
installs it. The skill without the package makes Claude rebuild StatCard by hand
every time. Neither half delivers the ask alone.

## Decisions taken

| Decision | Choice | Why |
|---|---|---|
| Distribution | **Public npm** | Coolify, CI and a fresh laptop need zero auth. A private package puts a PAT in every build container — one expiry breaks deploys across every app at once. The contents are tokens and presentational components, not business logic. |
| Where it lives | **`packages/ui` in this monorepo**, published from here | One copy, ever. LaunchOS is the proving ground: every change is validated against real screens before it reaches another project. |
| Migration style | **Incremental, behind re-export shims** | 62 files import these components. A big-bang rewrite of a live, earning app is not worth the risk when a one-line shim per path buys the same result. |
| Scope | Admin shell **+ portal + marketing** | Shoji's call. Phased so each slice ships independently. |

## Package shape

Subpath exports, so a project takes only what it needs and a marketing site does
not pull in the admin rail:

| Entry | Contents |
|---|---|
| `@launchflow/ui/styles` | `globals.css` — tokens, `@theme inline`, base layer |
| `@launchflow/ui` | Primitives (24 shadcn) + composites (StatCard, DataList, Panel, PageHeader, StatusBadge, EmptyState, Toolbar, KeyValue) |
| `@launchflow/ui/shell` | AppNav (the navy rail), GlobalSearch, BrandMark/BrandTile |
| `@launchflow/ui/portal` | The 8 portal components |
| `@launchflow/ui/marketing` | `marketing.css`, `motion.css` |

`cn` and the `Category` type ship from the root entry — everything depends on
them and they are 38 lines combined.

### Naming risk

`@launchflow/ui` returns 404 on the registry, so the package name is free. The
**scope** cannot be confirmed without logging in and attempting to create the
org; `launchflow` unscoped is already published by someone else at 0.0.1.

**Fallback, in order:** `@launchflowuk/ui`, then `@launchflow-os/ui`. Decide at
publish time, in Phase 1, before anything depends on the name.

## The four decouplings

These are the real engineering. Everything else is moving files.

### 1. `next/link` — the framework coupling

Nearly every component imports `next/link`. Hard-depending on Next.js means the
package cannot be used in a Vite or Express+React admin.

**Solution:** a `UIProvider` holding a `Link` component in context. The package
default renders a plain anchor; a Next project wraps its root once and passes
`next/link`. No component takes a link prop; no consumer configures anything per
component.

```tsx
// Next project, once, in the root layout
<UIProvider link={NextLink}>{children}</UIProvider>
```

### 2. `@launchos/core` — the business coupling

`AppNav` imports `MemberPermissions` and `NAV_GROUPS`; `GlobalSearch` imports
`SearchResults`. These are the two components that make a screen *look* like
LaunchOS, and the two that cannot ship as they stand.

**Solution:** invert them. Both take data as props against types the package
owns.

- `AppNav` takes `groups: NavGroup[]` — already-filtered, already-permitted. The
  package renders a rail; it does not decide who may see what. Permission
  filtering stays in LaunchOS where the permission model lives.
- `GlobalSearch` takes `results: SearchGroup[]` and an `onQuery` callback. The
  package owns the keyboard behaviour (Cmd+K, arrows across group boundaries,
  Enter opens top hit) and knows nothing about what is being searched.

`visibleNavGroups()` and the LaunchOS `NAV_GROUPS` constant stay in `apps/web`.

### 3. The brand asset

`BrandMark`/`BrandTile` render `next/image` against PNGs served from
`apps/web/public/brand/`. A package cannot reach into a consumer's `public/`
folder, and the asset is **not transparent** — it carries an opaque near-white
ground, so it only ever sits on white or off-white surfaces, or inside
`BrandTile`'s white chip on the navy rail.

**Solution:** `BrandMark` takes the image `src` as a prop, and `UIProvider`
carries a default. The wordmark PNGs stay in each consuming app's `public/`
folder rather than shipping inside the package — a LaunchFlow logo has no
business rendering in someone else's project, and a public package means someone
else's project is possible. Grays CabLine, whose front end is deliberately not
LaunchFlow-branded, is the case this protects.

### 4. `Category` — the shared vocabulary

`lib/categories.ts` (32 lines) is imported by StatCard, Panel and PageHeader. It
moves into the package wholesale. The five category hues are design decisions,
not LaunchOS business facts.

## Build and publish

**Ship compiled output via tsup**, with `"use client"` directives preserved —
several components are client components and a build that strips the directive
breaks them silently in an RSC app.

`transpilePackages` (consumer transpiles our TypeScript source) is the documented
fallback if directive preservation fights us. It is simpler but works only for
Next.js consumers, which is why it is not the default.

Publishing is `npm version <patch|minor|major>` then `npm publish --access public`,
run by hand. No changesets, no release CI — one maintainer, YAGNI.

Authentication is needed at exactly one moment — the first `npm publish` — and
at no point before it. Everything up to then runs on `workspace:*`.

## Migrating LaunchOS

`packages/ui` gains a `package.json`, which makes pnpm treat it as a workspace
member for the first time (`pnpm-workspace.yaml` already globs `packages/*`).
`apps/web` depends on it as `workspace:*`, so local development consumes the
local package and never the registry.

Each of the 62 importing files is migrated by replacing the component file with
a one-line re-export:

```ts
// apps/web/src/components/stat-card.tsx
export { StatCard, type StatCardProps } from "@launchflow/ui";
```

Call sites keep working untouched. Shims are deleted opportunistically later —
they are not a permanent layer, but nothing breaks while they exist.

**`apps/web/CLAUDE.md` and the root `CLAUDE.md` both need updating**: the current
text says `packages/ui` is "Reserved, not built — a README and nothing else, so
pnpm does not treat it as a workspace member." That stops being true in Phase 1.

## The Claude Code skill

`~/.claude/skills/launchflow-design/SKILL.md`, user scope so it applies to every
project on the machine without per-repo setup.

It fires when a project needs an admin, dashboard, portal or internal tool, and
carries: the install line, the `UIProvider` setup, the token import, a condensed
form of DESIGN.md's rules (geometry, type scale, the state vocabulary), and the
Never list verbatim. The Never list is the highest-value payload — every line on
it is a mistake that has already cost time once.

The skill points at DESIGN.md in the package for the full text rather than
duplicating it, so there is one source of truth.

## Testing

- **Vitest** in the package for logic that has bitten before: `figureSize` in
  StatCard (a £1,544.40 figure that wanted 207px of a 176px box and lost its last
  digits), and the `cn` size-vs-colour collision that has shipped twice.
- **The mobile-overflow Playwright spec moves into the package** as a harness a
  consumer can run against its own routes. In LaunchOS it keeps walking every
  admin and portal route at 375px. It exists because a Panel shipped without
  `min-w-0` and made the whole shell draggable sideways; typecheck cannot see
  layout.
- **LaunchOS itself is the integration test.** If a phase lands and LaunchOS
  still renders and passes its e2e suite, the extraction was clean.

## Phases

Each is independently shippable and independently useful.

| # | Phase | Delivers |
|---|---|---|
| 1 | **Tokens + `cn` + `Category`** | `@launchflow/ui/styles` published. Any project gets the right colours, type scale and geometry from one import. Package name settled here. |
| 2 | **The Claude Code skill** | Pulled forward deliberately: the moment tokens exist, the skill is what makes them automatic. Answers the original ask at the earliest possible point. |
| 3 | **Primitives** | The 24 themed shadcn components. |
| 4 | **Portable composites** | StatCard, DataList, Panel, PageHeader, StatusBadge, EmptyState, Toolbar, KeyValue. The character of the design. |
| 5 | **Admin shell** | AppNav + GlobalSearch, decoupled. The hard phase. |
| 6 | **Portal** | The 8 portal components. |
| 7 | **Marketing** | `marketing.css` + `motion.css`. |

After Phase 4 a new project can be made to look like LaunchOS by hand. After
Phase 5 it looks like LaunchOS out of the box.

## Risks

| Risk | Handling |
|---|---|
| `@launchflow` scope unavailable | Settle the name in Phase 1, before dependants exist. Fallbacks listed above. |
| Extraction breaks a live, earning app | Shims mean call sites never change. LaunchOS e2e runs at every phase boundary. Nothing deploys until Shoji says so. |
| `"use client"` stripped by the build | Verified in Phase 3 against a real RSC render, not assumed. `transpilePackages` is the documented fallback. |
| Package drifts from DESIGN.md | DESIGN.md moves into the package and becomes its README. The doc and the code ship together or not at all. |

## Out of scope

- Publishing anything to production or deploying. Build and push; Shoji chooses
  the moment.
- Migrating any other project (Thurrock, Cabio, Masjid) onto the package. That
  is a separate job once the package exists.
- A component playground or Storybook. LaunchOS is the playground.

## Settled, 8 September 2026

1. **Package name.** `@launchflow/ui`, falling back to `@launchflowuk/ui` if the
   scope is claimed. Shoji's call was "whichever" — the fallback is chosen, not
   left open, so Phase 1 cannot stall on it.
2. **`DESIGN.md` moves** into the package and becomes its README. A pointer stays
   at `apps/web/DESIGN.md`. Shoji: *"move the design md."*
3. **`npm login` is not a prerequisite.** It was listed as one in the first draft
   and that was wrong. Every phase up to the publish step runs on `workspace:*`
   against the local package and never contacts the registry. Authentication is
   needed at one moment — the first `npm publish` — and not before.
