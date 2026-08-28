/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireReadOnlySession } from "@/lib/auth/session";
import { appRegistry } from "@/generated/app-registry";
import { getUserById, hasAppGrant } from "@/lib/apps/access";
import { loadAppPage } from "@/lib/apps/loader";
import TrackAppOpen from "@/components/analytics/track-app-open";

interface Props {
  params: Promise<{ appSlug: string; path?: string[] }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { appSlug } = await params;
  const manifest = appRegistry.find((a) => a.slug === appSlug);
  return { title: manifest?.name ?? appSlug };
}

export default async function AppPage({ params }: Props) {
  const { appSlug, path = [] } = await params;

  const manifest = appRegistry.find((a) => a.slug === appSlug);
  if (!manifest) notFound();

  const session = await requireReadOnlySession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) redirect("/");

  // `hasAppGrant`, not `hasAppAccess`: the latter reads `user_apps`, which
  // records that a user installed the app on their dashboard — a layout
  // preference, not authorization — and has no global-app short-circuit, so it
  // redirected every user of every global app away from a page they were
  // entitled to. The API mount was corrected in the same change; a page and its
  // own API answering differently is worse than either answer alone.
  const allowed = await hasAppGrant(dbUser.id, appSlug);
  if (!allowed) redirect("/");

  const PageComponent = await loadAppPage(appSlug, path);
  if (!PageComponent) notFound();

  return (
    <>
      <TrackAppOpen appSlug={appSlug} />
      <PageComponent />
    </>
  );
}
