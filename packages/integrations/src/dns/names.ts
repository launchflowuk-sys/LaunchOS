/**
 * The two APIs address the same record differently: Hostinger wants the name
 * relative to the zone with `@` for the apex, Cloudflare wants the fully
 * qualified name. Callers hand us whatever the admin form or the agent had —
 * `@`, `www`, or `www.example.co.uk` — so both shapes are normalised here
 * rather than in each provider.
 */

function strip(name: string): string {
  return name.trim().replace(/\.+$/, "").toLowerCase();
}

/** `www`, or `@` for the apex. */
export function relativeName(name: string, zone: string): string {
  const clean = strip(name);
  const root = strip(zone);
  if (clean === "" || clean === "@" || clean === root) return "@";
  if (clean.endsWith(`.${root}`)) {
    const relative = clean.slice(0, -(root.length + 1));
    return relative.length > 0 ? relative : "@";
  }
  return clean;
}

/** `www.example.co.uk`, with the apex collapsing to the zone itself. */
export function fullyQualifiedName(name: string, zone: string): string {
  const root = strip(zone);
  const relative = relativeName(name, zone);
  return relative === "@" ? root : `${relative}.${root}`;
}
