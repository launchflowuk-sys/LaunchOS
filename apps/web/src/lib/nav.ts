import {
  BookOpen,
  Bot,
  ChartColumn,
  ChartLine,
  CreditCard,
  Globe,
  Inbox,
  LayoutDashboard,
  LayoutTemplate,
  LifeBuoy,
  type LucideIcon,
  Mail,
  Megaphone,
  Network,
  Package,
  Receipt,
  Settings,
  ShieldCheck,
  SquareCheckBig,
  TriangleAlert,
  Users,
  UsersRound,
  Wallet,
} from "lucide-react";
import type { Category } from "@/lib/categories";

export type NavItem = {
  label: string;
  href: string;
  /** 16px on the rail, `stroke-width 1.75` — set once by the nav, not here. */
  icon: LucideIcon;
};
export type NavGroup = { label: string; category: Category; items: readonly NavItem[] };

/**
 * The final admin navigation (spec §5). Every module in the spec has landed, so
 * every entry below is a link to a route that exists — the disabled "arrives in
 * Plan N" label the earlier plans rendered is gone with the last of them. An
 * entry added here without its route is a 404 in the sidebar, so add the route
 * first. "Open Cases" is the spec's name for the ticket list Plan 1 ships.
 *
 * `icon` is a component rather than a name, which is why `AppNav` imports this
 * module directly instead of receiving it as a prop: a function cannot cross
 * the server/client boundary. `category` is the group's hue from DESIGN.md.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Overview",
    category: "overview",
    items: [{ label: "Dashboard", href: "/", icon: LayoutDashboard }],
  },
  {
    label: "Delivery",
    category: "delivery",
    items: [
      { label: "Clients", href: "/clients", icon: Users },
      { label: "Websites", href: "/websites", icon: Globe },
      { label: "Domains", href: "/domains", icon: Network },
      { label: "Tasks", href: "/tasks", icon: SquareCheckBig },
    ],
  },
  {
    label: "Support",
    category: "support",
    items: [
      { label: "Inbox", href: "/inbox", icon: Inbox },
      { label: "Open Cases", href: "/cases", icon: LifeBuoy },
      { label: "Incidents", href: "/incidents", icon: TriangleAlert },
    ],
  },
  {
    label: "Money",
    category: "money",
    items: [
      { label: "Payments", href: "/payments", icon: CreditCard },
      { label: "Invoices", href: "/invoices", icon: Receipt },
      { label: "Ads", href: "/ads", icon: Megaphone },
      { label: "Ad reports", href: "/ads/reports", icon: ChartColumn },
      { label: "Reports", href: "/reports", icon: ChartLine },
    ],
  },
  {
    label: "Automation",
    category: "automation",
    items: [
      { label: "Approvals", href: "/approvals", icon: ShieldCheck },
      { label: "Agents", href: "/settings/agents", icon: Bot },
      { label: "Email", href: "/settings/email", icon: Mail },
      { label: "Knowledge Base", href: "/knowledge", icon: BookOpen },
    ],
  },
  {
    label: "Organisation",
    category: "organisation",
    items: [
      { label: "Team", href: "/team", icon: UsersRound },
      { label: "Settings", href: "/settings/organisation", icon: Settings },
      { label: "Billing", href: "/settings/billing", icon: Wallet },
      { label: "Packages", href: "/settings/packages", icon: Package },
      { label: "Task templates", href: "/settings/task-templates", icon: LayoutTemplate },
    ],
  },
];

/**
 * The one item that carries a live count on the rail. Approvals is where every
 * outward action stops for a human, so the number belongs where the owner can
 * see it from any screen (PRODUCT.md: "the most consequential screen").
 */
export const APPROVALS_HREF = "/approvals";
