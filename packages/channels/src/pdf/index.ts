/**
 * The document engine, behind its own entry point.
 *
 * `@launchos/channels/pdf`, not the package root, because `chromium.ts`
 * reaches for Playwright and the root index is imported by the Next.js app for
 * its email templates. A bundler that can see a path from that import to
 * `playwright` will try to bundle the browser driver into the web build; a
 * separate subpath means it never can.
 */
export * from "./screenshot.js";
export * from "./types.js";
export * from "./document.js";
export * from "./mock.js";
export * from "./chromium.js";
export * from "./factory.js";
