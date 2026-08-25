import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { appRegistry } from "@/generated/app-registry";
import { publicGateFor } from "@/lib/apps/types";
import { loadAppPage } from "@/lib/apps/loader";
import { isAppUnlocked } from "@/lib/apps/public-access";
import { hasAppPassword } from "@/lib/apps/app-password-store";
import PasswordGate from "@/components/apps/password-gate";

interface Props {
  params: Promise<{ appSlug: string; path?: string[] }>;
}

// Public surface is never crawler-indexed by default. Visitors arrive via
// direct links the installer shares; we explicitly opt out of search engines
// to keep app pages from accidentally leaking into Google. (A future
// manifest flag could opt in per-app.)
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { appSlug } = await params;
  const manifest = appRegistry.find((a) => a.slug === appSlug);
  return {
    title: manifest?.name ?? appSlug,
    robots: { index: false, follow: false },
  };
}

export default async function PublicAppPage({ params }: Props) {
  const { appSlug, path = [] } = await params;

  const manifest = appRegistry.find((a) => a.slug === appSlug);
  if (!manifest) notFound();

  // Resolve the declared auth set for this specific page path. Keys in
  // `pageVisibility` are POSIX paths relative to apps/<slug>/pages/, with
  // "" for the root page. Anything not declared defaults to ["session"], and a
  // session-only page is NOT reachable via /p/* — this is the load-bearing
  // safety property: a missing or typo'd manifest entry fails closed.
  const pageKey = path.join("/");
  const gate = publicGateFor(manifest.pageVisibility?.[pageKey]);
  // "key" is an API-only auth; the manifest schema rejects it on a page, so
  // reaching it here would mean a registry built from a stale schema.
  if (gate === "none" || gate === "key") notFound();

  if (gate === "password") {
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
            <div className="max-w-sm rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
              <h1 className="text-lg font-semibold text-gray-900">
                This app is not available
              </h1>
              <p className="mt-2 text-sm text-gray-600">
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
