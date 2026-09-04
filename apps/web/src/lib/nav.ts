export type NavItem = { label: string; href: string };
export type NavGroup = { label: string; items: readonly NavItem[] };

/**
 * The final admin navigation (spec §5). Every module in the spec has landed, so
 * every entry below is a link to a route that exists — the disabled "arrives in
 * Plan N" label the earlier plans rendered is gone with the last of them. An
 * entry added here without its route is a 404 in the sidebar, so add the route
 * first. "Open Cases" is the spec's name for the ticket list Plan 1 ships.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  { label: "Overview", items: [{ label: "Dashboard", href: "/" }] },
  {
    label: "Delivery",
    items: [
      { label: "Clients", href: "/clients" },
      { label: "Websites", href: "/websites" },
      { label: "Domains", href: "/domains" },
      { label: "Tasks", href: "/tasks" },
    ],
  },
  {
    label: "Support",
    items: [
      { label: "Inbox", href: "/inbox" },
      { label: "Open Cases", href: "/cases" },
      { label: "Incidents", href: "/incidents" },
    ],
  },
  {
    label: "Money",
    items: [
      { label: "Payments", href: "/payments" },
      { label: "Invoices", href: "/invoices" },
      { label: "Ads", href: "/ads" },
      { label: "Ad reports", href: "/ads/reports" },
      { label: "Reports", href: "/reports" },
    ],
  },
  {
    label: "Automation",
    items: [
      { label: "Approvals", href: "/approvals" },
      { label: "Agents", href: "/settings/agents" },
      { label: "Email", href: "/settings/email" },
      { label: "Knowledge Base", href: "/knowledge" },
    ],
  },
  {
    label: "Organisation",
    items: [
      { label: "Team", href: "/team" },
      { label: "Settings", href: "/settings/organisation" },
      { label: "Billing", href: "/settings/billing" },
      { label: "Packages", href: "/settings/packages" },
      { label: "Task templates", href: "/settings/task-templates" },
    ],
  },
];
