"use client";

import type { MemberPermissions } from "@launchos/core";
import {
  AppNav as Rail, AppNavSheet as RailSheet, initialsFromEmail,
} from "@launchflow/ui/components/app-nav";
import { BrandTile } from "@/components/brand-mark";
import { APPROVALS_HREF, visibleNavGroups } from "@/lib/nav";

export { initialsFromEmail };

/**
 * LaunchOS's binding of the design system's rail.
 *
 * The rail itself lives in `@launchflow/ui` and knows nothing about
 * permissions, approvals or LaunchFlow's wordmark. This file supplies all
 * three, and it is a **client** component for a reason: `NavItem.icon` holds a
 * Lucide component, and a component reference cannot be serialised across the
 * server/client boundary. Filtering here — rather than in `(admin)/layout.tsx`
 * — keeps the icons on one side of it.
 *
 * `permissions` is a plain object and crosses that boundary safely.
 */
type NavProps = {
  email: string;
  role: string;
  /** Pending approvals, counted on the server and shown on the rail. */
  pendingApprovals: number;
  /** What this member may see. Resolved on the server; the owner holds all five. */
  permissions: MemberPermissions;
};

function bind({ pendingApprovals, permissions }: Pick<NavProps, "pendingApprovals" | "permissions">) {
  return {
    groups: visibleNavGroups(permissions),
    brand: <BrandTile />,
    subtitle: "Admin portal",
    badges: { [APPROVALS_HREF]: pendingApprovals },
    srTitle: "LaunchOS",
  };
}

export function AppNav({ email, role, pendingApprovals, permissions }: NavProps) {
  return <Rail email={email} role={role} {...bind({ pendingApprovals, permissions })} />;
}

export function AppNavSheet({ email, role, pendingApprovals, permissions }: NavProps) {
  return <RailSheet email={email} role={role} {...bind({ pendingApprovals, permissions })} />;
}
