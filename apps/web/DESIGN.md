# Design system — moved

The LaunchFlow design system now lives in the package it is published from:

**[`packages/ui/DESIGN.md`](../../packages/ui/DESIGN.md)**

It moved so the specification and the code it governs ship together. A copy left
here would drift from the tokens within a release or two, and a design system
whose written rules disagree with its own CSS is worse than none.

Tokens: `packages/ui/src/styles/globals.css`, imported by
`apps/web/src/app/globals.css` as `@launchflow/ui/styles`.
