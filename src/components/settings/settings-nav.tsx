/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ACCOUNT_SECTIONS,
  ADMIN_SECTIONS,
  activeHref,
  type NavSection,
} from "@/lib/admin/sections";

/**
 * One labelled group of links.
 *
 * `aria-labelledby` points at the visible heading rather than duplicating it in
 * an `aria-label`, so a screen reader announces each region once, with the words
 * that are actually on screen. Two `<nav>`s rather than one with sub-headings:
 * they are separate landmarks, and a user jumping between landmarks should land
 * on "Administration" or "My Account", not on one undifferentiated list.
 */
export function NavGroup({
  id,
  label,
  sections,
  active,
}: {
  id: string;
  label: string;
  sections: NavSection[];
  /**
   * The one href highlighted across the whole sidebar, resolved by the parent.
   *
   * Resolved once for both groups rather than per group: `/apps/guide` matches
   * Apps by alias and App Manager by prefix, and two groups each
   * picking their own best would light up both at once.
   */
  active: string | null;
}) {
  return (
    <div>
      <h2
        id={id}
        className="mb-2 px-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground"
      >
        {label}
      </h2>
      <nav
        aria-labelledby={id}
        className="flex flex-row gap-1 overflow-x-auto md:flex-col md:gap-0.5"
      >
        {sections.map((section) => {
          const isActive = section.href === active;
          const Icon = section.icon;
          return (
            <Link
              key={section.href}
              href={section.href}
              // `aria-current` is what tells a screen reader which page this is;
              // the fill only tells someone who can see it.
              aria-current={isActive ? "page" : undefined}
              data-tour={section.dataTour}
              className={`flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-brand font-medium text-brand-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden />
              {section.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * The settings sidebar: what an admin configures, then what they configure for
 * themselves.
 *
 * `isAdmin` gates the whole Administration group rather than disabling its
 * links. A non-admin has no business seeing six pages they cannot open — and
 * the header menu already hides the same block on the same condition, so
 * showing it here would be the one place that leaked it.
 */
export default function SettingsNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const active = activeHref(pathname, [...ADMIN_SECTIONS, ...ACCOUNT_SECTIONS]);
  return (
    <div className="flex flex-col gap-6">
      {isAdmin && (
        <NavGroup
          id="admin-nav-label"
          label="Administration"
          sections={ADMIN_SECTIONS}
          active={active}
        />
      )}
      <NavGroup
        id="account-nav-label"
        label="My Account"
        sections={ACCOUNT_SECTIONS}
        active={active}
      />
    </div>
  );
}
