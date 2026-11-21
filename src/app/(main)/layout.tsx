/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import ReleaseBanner from "@/components/admin/release-banner";
import { AuthProvider } from "@/components/auth-provider";
import { DashboardEditProvider } from "@/components/dashboard/edit-mode-context";
import { PreferencesProvider } from "@/components/preferences-context";
import HeaderShell from "@/components/header-shell";
import {
  getBrandName,
  getLoginLogo,
  getMenuBarLogo,
} from "@/lib/branding/resolve";
import { requireReadOnlySession } from "@/lib/auth/session";
import { onboardingCompletedAtFor } from "@/lib/onboarding/completed";
import { TourProvider } from "@/components/onboarding/tour-context";
import WelcomeTour from "@/components/onboarding/welcome-tour";
import Installed from "@/components/onboarding/installed";
import Confetti from "@/components/onboarding/confetti";
import RegisterServiceWorker from "@/components/push/register-sw";
import OfflineOverlay from "@/components/offline-overlay";
import { SearchProvider } from "@/components/search/search-context";
import { getSearchPreferences } from "@/lib/search/preferences";

/**
 * Every page under `(main)` is session-dependent and must render per request.
 * Said directly, because a page Next could prerender at build time would reach
 * for a database that isn't there during a build.
 */
export const dynamic = "force-dynamic";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Resolved on the server: the menu bar is a client component, and resolving
  // the brand there would either flash the wrong mark or mismatch on hydration
  // — and the app filters that may change it are server code. The session is
  // resolved once, for the tour's stamp and the release banner, which would
  // each cost a read of the user's row otherwise.
  const [session, name, menuBarLogo] = await Promise.all([
    requireReadOnlySession(),
    getBrandName(),
    getMenuBarLogo(),
  ]);
  // Search settings with the session, so the menu bar's search icon is right
  // on the first paint.
  const [onboardingCompletedAt, searchPrefs] = await Promise.all([
    onboardingCompletedAtFor(session.user.id),
    getSearchPreferences(session.user.id),
  ]);
  // The sign-in mark only matters while the welcome tour is showing it, so
  // every other page skips its filters. Replaying the tour refreshes from the
  // server, which lands back here with the stamp cleared.
  const loginLogo =
    onboardingCompletedAt === null ? await getLoginLogo() : null;

  return (
    <AuthProvider>
      <PreferencesProvider>
        <SearchProvider initialPrefs={searchPrefs}>
          <TourProvider active={onboardingCompletedAt === null}>
            <DashboardEditProvider>
              <div className="flex h-screen flex-col">
                {/* In the column, not over it: the menu bar and the page start after it, so nothing overlaps. */}
                <ReleaseBanner isAdmin={session.user.isAdmin} userId={session.user.id} />
                <HeaderShell logo={menuBarLogo} name={name} />
                <main className="flex-1 overflow-auto bg-muted">{children}</main>
              </div>
              <WelcomeTour branding={{ name, menuBarLogo, loginLogo }} />
              <Confetti />
              <Installed name={name} logo={menuBarLogo} />
              <RegisterServiceWorker />
              <OfflineOverlay />
            </DashboardEditProvider>
          </TourProvider>
        </SearchProvider>
      </PreferencesProvider>
    </AuthProvider>
  );
}
