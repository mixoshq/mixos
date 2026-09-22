/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Link from "next/link";
import SettingsShell from "@/components/settings/settings-shell";
import GuideTabsShell, { type GuideTabDef } from "@/components/guide-tabs-shell";

/**
 * The frame the app, connector and theme guides share.
 *
 * All three are the same page with different words: the settings sidebar on
 * the left, a title and a "build this with Claude Code" callout, the prose,
 * and the section rail on the right. They were three hand-maintained copies of
 * that arrangement, which is the shape where a fix lands in one and the other
 * two quietly drift.
 *
 * SETTINGS SHELL AS A COMPONENT, NOT A LAYOUT. The guides live at
 * `/apps/guide`, `/connectors/guide` and `/themes/guide` — three unrelated
 * route segments, and `/apps` cannot take a layout at all because
 * `/apps/[appSlug]` renders installed apps beneath it. See SettingsShell.
 *
 * NOT LINKED FROM ANYWHERE. The "How to create …" buttons on the admin pages
 * open the same material on mixos.org (`@/lib/docs`), which is the copy that
 * gets maintained. These routes stay reachable by URL and are kept for now;
 * they are not deleted, just unreferenced.
 */
export default function GuidePage({
  title,
  back,
  intro,
  command,
  usage,
  tabs,
}: {
  title: string;
  /**
   * The registry this guide was opened from.
   *
   * Required, not optional. Every guide is reached from a registry page and
   * none of them is in the settings sidebar, so without this the only way back
   * is the browser's own button — and a guide you can only leave by going
   * backwards is one people stop opening.
   */
  back: { href: string; label: string };
  intro: React.ReactNode;
  /** The slash command that scaffolds this kind of thing, e.g. `/mixos app`. */
  command: string;
  /** A full example invocation, shown under the command. */
  usage: string;
  tabs: GuideTabDef[];
}) {
  const header = (
    <div>
      {/* Above the title, not beside or below it: this is the way out of the
          page, and the first thing at the top-left is where a reader looks for
          one. */}
      <Link
        href={back.href}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        &larr; Back to {back.label}
      </Link>
      <h1 className="mt-3 text-2xl font-bold">{title}</h1>
      <p className="mt-2 text-muted-foreground">{intro}</p>

      <div className="mt-4 rounded-md border border-primary/30 bg-primary/10 p-4 text-sm text-foreground">
        <p className="flex items-center gap-2 font-semibold">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          Build with Claude Code
        </p>
        <p className="mt-1">
          Use the{" "}
          <code className="rounded bg-primary/15 px-1.5 py-0.5 text-xs font-mono">
            {command}
          </code>{" "}
          slash command in Claude Code to scaffold or update one. It references
          all the documentation below to generate correct code.
        </p>
        <p className="mt-1.5 text-xs">
          Usage:{" "}
          <code className="rounded bg-primary/15 px-1 py-0.5 font-mono">
            {usage}
          </code>
        </p>
      </div>
    </div>
  );

  return (
    <SettingsShell>
      <GuideTabsShell tabs={tabs} header={header} />
    </SettingsShell>
  );
}
