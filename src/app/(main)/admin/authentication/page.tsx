import { requireReadOnlySession } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/apps/access";
import { getAuthConfigSummary } from "@/lib/auth/auth-config-store";
import AuthConfigForm from "@/components/admin/auth-config-form";

export default async function AuthenticationAdminPage() {
  const session = await requireReadOnlySession();
  await requireAdmin(session);

  const summary = await getAuthConfigSummary();

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">Authentication</h1>
      <p className="mt-2 text-muted-foreground">
        Control how users sign in to MixOS. Email and password is the
        default; enable SSO below to delegate authentication to an external
        OpenID Connect provider.
      </p>

      <div className="mt-8">
        <AuthConfigForm
          ssoEnabled={summary.ssoEnabled}
          issuerUrl={summary.oidcIssuerUrl}
          clientId={summary.oidcClientId}
          hasClientSecret={summary.hasClientSecret}
          adminClaimName={summary.adminClaimName}
          adminClaimValues={summary.adminClaimValues}
        />
      </div>
    </div>
  );
}
