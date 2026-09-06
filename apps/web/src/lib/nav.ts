import type { MemberPermissions, PermissionKey } from "@launchos/core";
import {
  BookOpen,
  Bot,
  CalendarClock,
  ChartColumn,
  ChartLine,
  Clock,
  CreditCard,
  FileSignature,
  Globe,
  HardHat,
  HeartPulse,
  Inbox,
  LayoutDashboard,
  LayoutTemplate,
  LifeBuoy,
  type LucideIcon,
  Mail,
  Megaphone,
  Network,
  Newspaper,
  Package,
  Receipt,
  Settings,
  ShieldCheck,
  SquareCheckBig,
  Split,
  Sunrise,
  Trophy,
  TriangleAlert,
  UserPlus,
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
  /**
   * The permission that shows this entry. Absent means every member sees it.
   * Hiding is a courtesy, not the guard: the server actions behind each area
   * call `requirePermission` themselves (`src/lib/permissions.ts`).
   */
  permission?: PermissionKey;
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
      // New business coming in: the website form and self-serve signup land
      // here before they are clients. The page is W3b's; the entry is here so
      // the rail is edited in one place.
      { label: "Leads", href: "/leads", icon: UserPlus },
      // Discovery calls booked through `/book`: upcoming and past, outcomes,
      // the join link. After Leads because that is where most of them come
      // from; the only nav entry the client-workflow work adds.
      { label: "Meetings", href: "/meetings", icon: CalendarClock },
      // Where a paid click lands before it is a lead. Beside Leads and
      // Meetings because a funnel is the front of the same queue: five
      // questions on a phone, the name and number asked in the middle.
      { label: "Funnels", href: "/funnels", icon: Split },
      // The priced offer that follows the call. It sits after Meetings rather
      // than immediately after Leads because that is the order the work
      // happens in — enquiry, call, proposal — and it is gated on `billing`
      // because a proposal is a price and a subscription in waiting, the same
      // area as Invoices and Packages. Staff hold `billing` by default.
      { label: "Proposals", href: "/proposals", icon: FileSignature, permission: "billing" },
      // The build an accepted proposal turns into. After Proposals for the
      // same reason Proposals is after Meetings: enquiry, call, proposal,
      // project is the order the work happens in. Ungated like Tasks — a
      // project is delivery work and the permission vocabulary has no key for
      // it.
      { label: "Projects", href: "/projects", icon: HardHat },
      { label: "Websites", href: "/websites", icon: Globe },
      { label: "Domains", href: "/domains", icon: Network },
      { label: "Tasks", href: "/tasks", icon: SquareCheckBig },
      { label: "Content", href: "/content", icon: Newspaper, permission: "content" },
      // The public portfolio. Gated on `content` beside the content calendar:
      // both are copy that goes out under LaunchFlow's name, and publishing a
      // case study puts a client's story on the marketing site.
      { label: "Case studies", href: "/case-studies", icon: Trophy, permission: "content" },
    ],
  },
  {
    label: "Support",
    category: "support",
    items: [
      { label: "Inbox", href: "/inbox", icon: Inbox, permission: "support" },
      { label: "Open Cases", href: "/cases", icon: LifeBuoy, permission: "support" },
      { label: "Incidents", href: "/incidents", icon: TriangleAlert, permission: "support" },
    ],
  },
  {
    label: "Money",
    category: "money",
    items: [
      { label: "Payments", href: "/payments", icon: CreditCard, permission: "billing" },
      { label: "Invoices", href: "/invoices", icon: Receipt, permission: "billing" },
      { label: "Ads", href: "/ads", icon: Megaphone, permission: "billing" },
      { label: "Ad reports", href: "/ads/reports", icon: ChartColumn, permission: "billing" },
      { label: "Reports", href: "/reports", icon: ChartLine, permission: "billing" },
    ],
  },
  {
    label: "Automation",
    category: "automation",
    items: [
      { label: "Approvals", href: "/approvals", icon: ShieldCheck, permission: "approvals" },
      { label: "Briefs", href: "/briefs", icon: Sunrise },
      { label: "Agents", href: "/settings/agents", icon: Bot, permission: "settings" },
      { label: "Email", href: "/settings/email", icon: Mail, permission: "settings" },
      { label: "Knowledge Base", href: "/knowledge", icon: BookOpen, permission: "settings" },
    ],
  },
  {
    label: "Organisation",
    category: "organisation",
    items: [
      { label: "Team", href: "/team", icon: UsersRound, permission: "settings" },
      // Not "Team health": three specs look the rail up by `name: "Team"`, and
      // a role name matches as a substring.
      { label: "Health", href: "/team/health", icon: HeartPulse, permission: "settings" },
      // Everyone: a member without `settings` still sees their own week.
      { label: "Timesheets", href: "/team/timesheets", icon: Clock },
      { label: "Settings", href: "/settings/organisation", icon: Settings, permission: "settings" },
      { label: "Billing", href: "/settings/billing", icon: Wallet, permission: "settings" },
      { label: "Packages", href: "/settings/packages", icon: Package, permission: "settings" },
      { label: "Task templates", href: "/settings/task-templates", icon: LayoutTemplate, permission: "settings" },
    ],
  },
];

/**
 * The groups a member sees: every entry whose permission they hold, and no
 * group left standing empty. The owner holds all five, so this is the full
 * list for them.
 */
export function visibleNavGroups(permissions: MemberPermissions): readonly NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.permission || permissions[item.permission]),
  })).filter((group) => group.items.length > 0);
}

/**
 * The one item that carries a live count on the rail. Approvals is where every
 * outward action stops for a human, so the number belongs where the owner can
 * see it from any screen (PRODUCT.md: "the most consequential screen").
 */
export const APPROVALS_HREF = "/approvals";
