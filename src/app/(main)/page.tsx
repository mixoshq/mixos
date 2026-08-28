/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { requireReadOnlySession } from "@/lib/auth/session";
import { ensureUser, getUserApps } from "@/lib/apps/access";
import { getDashboard } from "@/lib/dashboard/actions";
import { getOnboardingCompletedAt } from "@/lib/onboarding/actions";
import { appRegistry } from "@/generated/app-registry";
import { hooks } from "@/lib/hooks";
import DashboardGrid from "@/components/dashboard/grid";
import WelcomeModal from "@/components/onboarding/welcome-modal";

export default async function DashboardPage() {
  const session = await requireReadOnlySession();
  const userId = await ensureUser(session.user);
  const enabledSlugs = await getUserApps(userId);
  const enabledApps = appRegistry.filter((a) => enabledSlugs.includes(a.slug));

  // Only active apps' hooks will fire
  hooks.setActiveApps(enabledSlugs);

  const [{ layout, widgets }, onboardingCompletedAt] = await Promise.all([
    getDashboard(),
    getOnboardingCompletedAt(),
  ]);

  const showWelcome =
    onboardingCompletedAt === null &&
    enabledSlugs.length === 0 &&
    widgets.length === 0;

  return (
    <div className="h-full p-4">
      <DashboardGrid
        initialLayout={layout}
        widgets={widgets}
        availableApps={enabledApps}
      />
      {showWelcome && <WelcomeModal />}
    </div>
  );
}
