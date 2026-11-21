/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { redirect } from "next/navigation";
import SearchSettings from "@/components/search/search-settings";
import { getUserById } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import { searchSourcesFor } from "@/lib/search/server";

export default async function SearchSettingsPage() {
  const session = await requireReadOnlySession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) redirect("/login");
  const { sources } = await searchSourcesFor(dbUser.id);

  return (
    <section>
      <h1 className="text-2xl font-bold text-foreground">Search</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Choose how you open search, and which apps it looks in first.
      </p>
      <SearchSettings sources={sources} />
    </section>
  );
}
