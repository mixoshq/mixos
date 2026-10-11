/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appRegistry } from "@/generated/app-registry";
import { checkAppGate } from "@/lib/apps/app-gate";
import { publicPageAccess } from "@/lib/apps/public-page";
import { loadAppPage } from "@/lib/apps/loader";
import { isAppUnlocked } from "@/lib/apps/public-access";
import { hasAppPassword } from "@/lib/apps/app-password-store";
import AppUpdating from "@/components/apps/app-updating";
import PasswordGate from "@/components/apps/password-gate";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Props {
  params: Promise<{ appSlug: string; path?: string[] }>;
}

// Public surface is never crawler-indexed by default. Visitors arrive via
// direct links the installer shares; we explicitly opt out of search engines
// to keep app pages from accidentally leaking into Google. (A future
// manifest flag could opt in per-app.)
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { appSlug, path = [] } = await params;
  // A page this route will not serve does not name its app either.
  const access = await publicPageAccess(
    appSlug,
    path.join("/"),
    appRegistry,
    checkAppGate,
  );
  return {
    title: access.kind === "not-served" ? appSlug : access.manifest.name,
    robots: { index: false, follow: false },
  };
}

export default async function PublicAppPage({ params }: Props) {
  const { appSlug, path = [] } = await params;

  // Resolve the declared auth set for this specific page path. Keys in
  // `pageVisibility` are POSIX paths relative to apps/<slug>/pages/, with
  // "" for the root page. Anything not declared defaults to ["session"], and a
  // session-only page is NOT reachable via /p/* — this is the load-bearing
  // safety property: a missing or typo'd manifest entry fails closed. So is an
  // app an admin has deactivated, on this surface as on every other.
  const pageKey = path.join("/");
  const access = await publicPageAccess(
    appSlug,
    pageKey,
    appRegistry,
    checkAppGate,
  );
  if (access.kind === "not-served") notFound();
  // The app's own migrations are behind: the app gate holds back its code, so
  // the page is not loaded. The proxy normally answers this first, with a 503.
  if (access.kind === "updating") return <AppUpdating fullScreen />;
  const { manifest } = access;

  if (access.kind === "password") {
    const unlocked = await isAppUnlocked(appSlug);
    if (!unlocked) {
      // If the manifest says password but the installer hasn't set one,
      // fail closed. Don't render the page; don't even show the gate
      // (entering any password would also fail) — surface the
      // misconfiguration so the operator notices and the visitor gets a
      // consistent "not available" state instead of a hanging form.
      if (!(await hasAppPassword(appSlug))) {
        console.error(
          `[public-page] app="${appSlug}" page="${pageKey}" is password-protected per manifest but no app_passwords row exists — installer must set a password`,
        );
        return (
          <div className="flex min-h-screen items-center justify-center bg-muted px-4">
            <div className={cn(CARD_SHELL, "max-w-sm p-5 text-center")}>
              <h1 className="text-lg font-semibold text-card-foreground">
                This app is not available
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                The administrator hasn&apos;t finished setting up access for
                this page. Please try again later.
              </p>
            </div>
          </div>
        );
      }
      const returnTo = "/p/" + appSlug + (pageKey ? "/" + pageKey : "");
      return (
        <PasswordGate
          appName={manifest.name}
          appSlug={appSlug}
          returnTo={returnTo}
        />
      );
    }
  }

  // visibility is "public" or "password" + unlocked — render the page.
  // Reuse the same loader the authenticated surface uses; page files don't
  // need to know which surface they're served from.
  const PageComponent = await loadAppPage(appSlug, path);
  if (!PageComponent) notFound();

  return <PageComponent />;
}
