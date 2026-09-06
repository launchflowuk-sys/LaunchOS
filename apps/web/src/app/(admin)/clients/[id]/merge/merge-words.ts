/**
 * Core reports a merge as counts per SQL table (`subscriptions: 3`). The
 * confirm screen says it the way the rail does: "3 subscriptions, 2 invoices,
 * 1 site". A table nobody named here falls back to its name with the
 * underscores taken out, so a new client-owned table is still readable
 * before it is given a word.
 */
const WORDS: Readonly<Record<string, readonly [singular: string, plural: string]>> = {
  billing_profiles: ["billing profile", "billing profiles"],
  client_contacts: ["contact", "contacts"],
  client_payment_accounts: ["payment account", "payment accounts"],
  subscriptions: ["subscription", "subscriptions"],
  invoices: ["invoice", "invoices"],
  payments: ["payment", "payments"],
  sites: ["site", "sites"],
  domains: ["domain", "domains"],
  client_access_entries: ["access entry", "access entries"],
  conversations: ["conversation", "conversations"],
  tickets: ["case", "cases"],
  tasks: ["task", "tasks"],
  activity_events: ["timeline entry", "timeline entries"],
  meetings: ["meeting", "meetings"],
  leads: ["lead", "leads"],
  ad_accounts: ["ad account", "ad accounts"],
  content_briefs: ["content brief", "content briefs"],
  content_channels: ["content channel", "content channels"],
  content_items: ["planned post", "planned posts"],
  content_assets: ["image", "images"],
  documents: ["document", "documents"],
  proposals: ["proposal", "proposals"],
  projects: ["project", "projects"],
  project_phases: ["project phase", "project phases"],
  project_milestones: ["milestone", "milestones"],
  case_studies: ["case study", "case studies"],
  content_reports: ["content report", "content reports"],
  client_reports: ["client report", "client reports"],
  client_users: ["portal login", "portal logins"],
  email_identities: ["support address", "support addresses"],
};

/** Whether the table has been given a word here (the test holds it to core's list). */
export function hasWord(table: string): boolean {
  return table in WORDS;
}

/** "3 subscriptions", "1 site", "2 client widgets" for a table without a word. */
export function countPhrase(table: string, count: number): string {
  const words = WORDS[table];
  if (words) return `${count} ${count === 1 ? words[0] : words[1]}`;
  const plain = table.replace(/_/g, " ");
  return `${count} ${count === 1 ? plain.replace(/s$/, "") : plain}`;
}

/** The counts as one sentence fragment, in the order core gave them; empty string when nothing. */
export function describeCounts(counts: Readonly<Record<string, number>>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => countPhrase(table, n))
    .join(", ");
}

/** Every row across the tables — "moved 6 records" for the toast. */
export function totalCount(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}
