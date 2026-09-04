/**
 * `notifications.link` (and, later, any other stored link written by a service
 * or an agent) is free text. Only a value that can be nothing other than a path
 * inside this app is ever rendered as a clickable target.
 *
 * Accepted: a single leading `/` followed by a non-`/`, non-`\` character, or
 * exactly `/`.
 *
 * Rejected, and why each one matters:
 *  - `//evil.example/login` — a protocol-relative URL. It starts with `/`, so a
 *    `startsWith("/")` check passes it, and the browser then loads
 *    `https://evil.example/login`. This is the off-site case a naive guard misses.
 *  - `/\evil.example` — normalised to the same protocol-relative navigation by
 *    Chrome and Safari, so every backslash is refused outright.
 *  - `javascript:alert(1)`, `https://evil.example`, `mailto:…` — any scheme.
 *  - anything containing `://` anywhere, belt and braces against a value that
 *    smuggles an absolute URL past the first character.
 */
export function isInAppPath(link: string | null | undefined): link is string {
  if (typeof link !== "string") return false;
  if (link.includes("\\") || link.includes("://")) return false;
  return /^\/(?![/\\])/.test(link);
}
