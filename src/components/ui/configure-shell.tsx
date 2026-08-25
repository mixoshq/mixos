"use client";

/**
 * Layout for an app's Configure area: a back link + title, a left sub-nav, and
 * a content column.
 *
 * WHEN TO USE THIS. An app's settings belong on a Configure page — reached from
 * a gear icon in the page header — when they are **app-wide**: things an admin
 * sets once that apply to every record. Settings that belong to *one record*
 * go in a modal on that record's page instead, where the thing being configured
 * is still on screen. Getting this backwards produces either a settings page
 * that needs a record ID in the URL, or a modal an admin has to hunt for.
 *
 * NOTE ON LAYOUT. App pages get no shared layout in this version of Next, so
 * there is no `layout.tsx` to hang this off — every Configure page renders the
 * shell itself and passes its own `active` key. That's not an oversight to fix;
 * it's the constraint this component exists to paper over.
 *
 * NOTE ON NAV KEYS. Each key doubles as the URL segment, so it is frozen even
 * when the label changes. A settings panel relabelled "Resource Library" still
 * lives at `customer_resources` — which is also the table and route behind it.
 * Renaming the key breaks bookmarks and any link anyone has shared.
 */

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export interface ConfigureNavItem {
  /** URL segment AND identity. Frozen — see the note above. */
  key: string;
  /** Display text. Safe to change. */
  label: string;
}

export default function ConfigureShell({
  appSlug,
  nav,
  active,
  title = "Configure",
  children,
}: {
  /** The app's folder name, used to build every href. */
  appSlug: string;
  /** Ordered the way an admin sets the app up, not alphabetically. */
  nav: ConfigureNavItem[];
  /** `key` of the item to mark current. */
  active: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col p-6">
      <header className="mb-6 flex items-start gap-3">
        <Link
          href={`/apps/${appSlug}`}
          className="mt-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted"
        >
          <ArrowLeft aria-hidden className="h-4 w-4" />
          Back
        </Link>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {title}
        </h1>
      </header>

      <div className="flex flex-1 gap-8">
        <nav className="w-60 shrink-0">
          <ul className="space-y-1">
            {nav.map((item) => {
              const isActive = item.key === active;
              return (
                <li key={item.key}>
                  <Link
                    href={`/apps/${appSlug}/configure/${item.key}`}
                    aria-current={isActive ? "page" : undefined}
                    className={`block rounded-md px-3 py-2 text-sm font-medium ${
                      isActive
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
