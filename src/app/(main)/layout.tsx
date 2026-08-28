/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { AuthProvider } from "@/components/auth-provider";
import { DashboardEditProvider } from "@/components/dashboard/edit-mode-context";
import { PreferencesProvider } from "@/components/preferences-context";
import HeaderShell from "@/components/header-shell";
import { getActiveTheme } from "@/lib/themes/active";
import OnboardingTour from "@/components/onboarding/onboarding-tour";
import CongratulationsModal from "@/components/onboarding/congratulations-modal";
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
  const { theme } = await getActiveTheme();
  const logo = theme.assets.logo ? `${theme.assetBase}/${theme.assets.logo}` : null;

  return (
    <AuthProvider>
      <PreferencesProvider>
        <DashboardEditProvider>
          <div className="flex h-screen flex-col">
            <HeaderShell logo={logo} />
            <main className="flex-1 overflow-auto bg-muted">
              {children}
            </main>
          </div>
          <OnboardingTour />
          <CongratulationsModal />
          <RegisterServiceWorker />
          <OfflineOverlay />
        </DashboardEditProvider>
      </PreferencesProvider>
    </AuthProvider>
  );
}
