import { requireReadOnlySession } from "@/lib/auth/session";
import {
  ensureUser,
  getUserApps,
  getUserGrantedSlugs,
} from "@/lib/apps/access";
import { appRegistry } from "@/generated/app-registry";
import { getRegisteredSlugs } from "@/lib/apps/admin-actions";
import AppManagerList from "@/components/apps/app-manager-list";

export default async function AppsPage() {
  const session = await requireReadOnlySession();
  const userId = await ensureUser(session.user);
  const [installedSlugs, grantedSlugs, registeredSlugs] = await Promise.all([
    getUserApps(userId),
    getUserGrantedSlugs(userId),
    getRegisteredSlugs(),
  ]);

  const registered = new Set(registeredSlugs);
  const granted = new Set(grantedSlugs);
  const availableApps = appRegistry.filter(
    (a) => registered.has(a.slug) && granted.has(a.slug),
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold">App Manager</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Toggle each on to install it on your dashboard.
      </p>

      <div className="mt-6">
        {/*
          Always empty: user-scoped (per-user OAuth) connectors were removed
          from the platform — see docs/connectors/architecture.md, "One
          credential set per connector". Every connector is tenant-scoped now,
          and that gate is enforced upstream: `registeredSlugs` above only
          contains apps whose declared connectors an admin has already
          configured (src/lib/apps/connector-gates.ts, applied in
          src/app/(main)/admin/apps/page.tsx). So there is nothing left for this
          prop to carry, and nothing is lost by passing {}.

          The prop itself is dead weight that AppManagerList and AppToggleList
          still declare, along with a "Connect →" link to /account/connections —
          a route that no longer exists. Deleting the prop chain in those two
          components is the real fix; this file cannot reach them.
        */}
        <AppManagerList
          apps={availableApps}
          installedSlugs={installedSlugs}
          missingUserConnectorsBySlug={{}}
        />
      </div>

      <p className="mt-12 text-center text-xs text-muted-foreground">
        Made in Detroit with 🫶🏽
      </p>
    </div>
  );
}
