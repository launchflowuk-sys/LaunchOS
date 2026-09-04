export type NavItem = { label: string; href: string; plan?: 3 | 4 | 5 };
export type NavGroup = { label: string; items: readonly NavItem[] };

/**
 * The final admin navigation (spec §5). Items whose module arrives in a later
 * plan render as disabled labels rather than links to routes that 404.
 * "Open Cases" is the spec's name for the ticket list Plan 1 already ships.
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
      { label: "Ads", href: "/ads", plan: 5 },
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
      { label: "Packages", href: "/settings/packages" },
      { label: "Task templates", href: "/settings/task-templates" },
    ],
  },
];
