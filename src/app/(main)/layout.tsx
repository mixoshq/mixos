/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AuthProvider } from "@/components/auth-provider";
import { DashboardEditProvider } from "@/components/dashboard/edit-mode-context";
import { PreferencesProvider } from "@/components/preferences-context";
import HeaderShell from "@/components/header-shell";
import { getActiveTheme } from "@/lib/themes/active";
import { getOnboardingCompletedAt } from "@/lib/onboarding/actions";
import { TourProvider } from "@/components/onboarding/tour-context";
import WelcomeTour from "@/components/onboarding/welcome-tour";
import Guide from "@/components/onboarding/guide";
import Confetti from "@/components/onboarding/confetti";
import RegisterServiceWorker from "@/components/push/register-sw";
import OfflineOverlay from "@/components/offline-overlay";

/**
 * Every page under `(main)` is session-dependent and must render per request.
 *
 * This used to be true only by accident: the layout called `isLocalRequest()`,
 * which reads `headers()`, and that opted the whole segment into dynamic
 * rendering as a side effect. When that call went away with the localhost band,
 * `/apps/guide` started prerendering at build time and failed reaching for
 * Supabase, which is not available during a build. Stating it directly is what
 * that side effect was silently buying.
 */
export const dynamic = "force-dynamic";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Resolved on the server: the menu bar is a client component, and sniffing
  // the theme there would either flash the wrong mark or mismatch on hydration.
  const [{ theme }, onboardingCompletedAt] = await Promise.all([
    getActiveTheme(),
    getOnboardingCompletedAt(),
  ]);
  const logo = theme.assets.logo
    ? `${theme.assetBase}/${theme.assets.logo}`
    : null;

  return (
    <AuthProvider>
      <PreferencesProvider>
        <TourProvider active={onboardingCompletedAt === null}>
          <DashboardEditProvider>
            <div className="flex h-screen flex-col">
              <HeaderShell logo={logo} />
              <main className="flex-1 overflow-auto bg-muted">{children}</main>
            </div>
            <WelcomeTour logo={logo} />
            <Guide />
            <Confetti />
            <RegisterServiceWorker />
            <OfflineOverlay />
          </DashboardEditProvider>
        </TourProvider>
      </PreferencesProvider>
    </AuthProvider>
  );
}
