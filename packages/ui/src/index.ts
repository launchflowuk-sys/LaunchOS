/**
 * @launchflow/ui — the LaunchFlow design system.
 *
 * The rules these pieces enforce are in DESIGN.md, which ships with this
 * package. Read the "Never" list before adding anything: every line on it was
 * added after that exact mistake shipped once.
 *
 * Primitives are at `@launchflow/ui/ui/<name>`, composites at
 * `@launchflow/ui/components/<name>`. Both are also re-exported here.
 */
export { cn } from "./lib/utils.js";
export * from "./lib/format.js";
export { type Category, CATEGORY_TEXT, CATEGORY_DOT } from "./lib/categories.js";

export * from "./components/stat-card.js";
export * from "./components/panel.js";
export * from "./components/page-header.js";
export * from "./components/data-list.js";
export * from "./components/empty-state.js";
export * from "./components/toolbar.js";
export * from "./components/key-value.js";
export * from "./components/status-badge.js";
export * from "./components/app-nav.js";
export * from "./components/inline-alert.js";
