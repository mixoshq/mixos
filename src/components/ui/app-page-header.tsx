/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

/**
 * The header band at the top of an app page: title, optional subtitle, and a
 * right-aligned row of actions.
 *
 * ACTION HIERARCHY. Actions that belong here are the ones a user reaches for
 * repeatedly — Refresh, a sibling view, Configure. Everything else (destructive
 * operations, mode toggles, external links, things used once a month) belongs
 * in an overflow menu, not spread across the header. A header with nine buttons
 * has no primary action, only nine equal ones.
 *
 * Actions render as bordered secondary buttons by default. At most one should
 * pass `variant: "primary"` — if two things are primary, neither is.
 */

import Link from "next/link";
import type { LucideIcon } from "lucide-react";

export interface HeaderAction {
  label: string;
  icon?: LucideIcon;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
  /** Spin the icon — for an in-flight refresh. */
  busy?: boolean;
  /** At most one per header. */
  variant?: "primary" | "secondary";
}

export default function AppPageHeader({
  title,
  subtitle,
  actions = [],
  className = "",
}: {
  title: string;
  /** A stat, a count, a filter summary. Keep it to one line. */
  subtitle?: React.ReactNode;
  actions?: HeaderAction[];
  className?: string;
}) {
  return (
    <header
      className={`mix-page-header mb-4 flex items-center justify-between gap-4 ${className}`}
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {title}
        </h1>
        {subtitle && (
          <div className="text-sm text-muted-foreground">{subtitle}</div>
        )}
      </div>
      {actions.length > 0 && (
        <div className="flex shrink-0 items-center gap-2">
          {actions.map((action) => (
            <HeaderActionButton key={action.label} {...action} />
          ))}
        </div>
      )}
    </header>
  );
}

function HeaderActionButton({
  label,
  icon: Icon,
  onClick,
  href,
  disabled,
  busy,
  variant = "secondary",
}: HeaderAction) {
  const className =
    variant === "primary"
      ? "inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      : "inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:opacity-50";

  const inner = (
    <>
      {Icon && (
        <Icon aria-hidden className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
      )}
      {label}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={className}>
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={className}
    >
      {inner}
    </button>
  );
}
