/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getUserById } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import { releaseNoteHistoryFor } from "@/lib/release-notes/server";
import ReleaseNotesBrowser from "@/components/release-notes/release-notes-browser";
import SettingsShell from "@/components/settings/settings-shell";

export const metadata: Metadata = { title: "Release Notes" };

/**
 * App Manager's Release Notes page: every note for MixOS and for what is on in
 * this person's workspace (src/lib/release-notes/server.ts), where the menu
 * bar's popover shows the last 14 days'.
 *
 * Under /apps, so the settings sidebar keeps App Manager lit. A static route
 * wins over /apps/[appSlug], which is why no app may be called `release-notes`
 * (RESERVED_APP_SLUGS in src/lib/apps/app-identifiers.ts).
 */
export default async function ReleaseNotesPage() {
  const session = await requireReadOnlySession();
  const user = await getUserById(session.user.id);
  if (!user) redirect("/");
  const history = await releaseNoteHistoryFor(user.id);

  return (
    <SettingsShell>
      <Link
        href="/apps"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" aria-hidden />
        App Manager
      </Link>
      <ReleaseNotesBrowser {...history} />
    </SettingsShell>
  );
}
