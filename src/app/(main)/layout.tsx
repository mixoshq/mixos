import { AuthProvider } from "@/components/auth-provider";
import { DashboardEditProvider } from "@/components/dashboard/edit-mode-context";
import { PreferencesProvider } from "@/components/preferences-context";
import HeaderShell from "@/components/header-shell";
import OnboardingTour from "@/components/onboarding/onboarding-tour";
import CongratulationsModal from "@/components/onboarding/congratulations-modal";
import RegisterServiceWorker from "@/components/push/register-sw";
import OfflineOverlay from "@/components/offline-overlay";
import { isLocalRequest } from "@/lib/env/local-host";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Resolved on the server so the local colours are in the first paint —
  // sniffing the hostname in the client would either flash the production
  // navy or mismatch on hydration.
  const isLocal = await isLocalRequest();

  return (
    <AuthProvider>
      <PreferencesProvider>
        <DashboardEditProvider>
          <div className="flex h-screen flex-col">
            <HeaderShell isLocal={isLocal} />
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
