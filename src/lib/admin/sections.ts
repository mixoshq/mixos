/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  AppWindow,
  BarChart3,
  Bot,
  Clock,
  LayoutGrid,
  Palette,
  Plug,
  Settings,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";

/**
 * The navigable sections of the settings area, in the order they are shown.
 *
 * ONE definition, read by the admin sidebar, the account sidebar and the header
 * menu. They were each written out separately, which is the arrangement where a
 * new page gets added to one and not the others — and the one it misses is
 * whichever the author did not happen to be looking at.
 *
 * `/admin` itself is absent deliberately: it only redirects to the first real
 * page.
 */
export interface NavSection {
  label: string;
  href: string;
  icon: LucideIcon;
  /**
   * Extra paths that belong to this section but do not nest under its href.
   *
   * The authoring guides are the case: `/apps/guide` sits beside the Apps page
   * in a user's head, but that page lives at `/admin/apps` and the guide could
   * not be routed under it — `/apps/guide` has to stay where the Apps page
   * already links to it. Without an alias the guide lights up "App Manager"
   * instead, because `/apps` is a genuine prefix of it.
   */
  aliases?: string[];
}

export const ADMIN_SECTIONS: NavSection[] = [
  { label: "Users", href: "/admin/users", icon: Users },
  {
    label: "Apps",
    href: "/admin/apps",
    icon: AppWindow,
    aliases: ["/apps/guide"],
  },
  {
    label: "Connectors",
    href: "/admin/connectors",
    icon: Plug,
    aliases: ["/connectors/guide"],
  },
  {
    label: "Themes",
    href: "/admin/themes",
    icon: Palette,
    aliases: ["/themes/guide"],
  },
  { label: "Scheduled Jobs", href: "/admin/scheduled-jobs", icon: Clock },
  { label: "Analytics", href: "/admin/analytics", icon: BarChart3 },
];

/**
 * The signed-in user's own settings. App Manager belongs here rather than with
 * Administration: installing an app is a personal choice, where the admin Apps
 * page decides what exists to install at all.
 */
export const ACCOUNT_SECTIONS: NavSection[] = [
  { label: "Account", href: "/account", icon: UserCog },
  { label: "Preferences", href: "/account/preferences", icon: Settings },
  {
    label: "App Manager",
    href: "/apps",
    icon: LayoutGrid,
  },
  { label: "My Connections", href: "/account/connections", icon: Plug },
  { label: "MCP Connections", href: "/account/mcp", icon: Bot },
];

/**
 * The section a path belongs to: the LONGEST href that matches it.
 *
 * Longest wins because these hrefs nest. `/account` is a prefix of
 * `/account/preferences`, so a plain `startsWith` lights up two entries at once
 * while the user is on one page — which the hand-written navs each worked
 * around with their own `href !== "/account"` special case. Comparing lengths
 * needs no special case and cannot be forgotten by the next nested route.
 * Aliases join the same comparison on their own length, so a longer alias
 * beats a shorter real href.
 */
export function activeHref(
  pathname: string,
  sections: NavSection[],
): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const section of sections) {
    for (const candidate of [section.href, ...(section.aliases ?? [])]) {
      const matches =
        pathname === candidate || pathname.startsWith(`${candidate}/`);
      // The alias competes on its own length, not its section's: `/apps/guide`
      // has to outrank App Manager's `/apps`, which it only does as itself.
      if (matches && candidate.length > bestLength) {
        best = section.href;
        bestLength = candidate.length;
      }
    }
  }
  return best;
}
