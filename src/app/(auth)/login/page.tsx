import { isSsoEnabled } from "@/lib/auth/auth-config-store";
import CredentialsForm from "./credentials-form";
import SsoButton from "./sso-button";

// isSsoEnabled() reads from Postgres via the Supabase client, which Next's
// static-detection doesn't track. Without this, the page is prerendered at
// build time with ssoOn=false baked in, so toggling SSO on doesn't surface
// until the next revalidation.
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const ssoOn = await isSsoEnabled();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-mixcharcoal px-4">
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-white/5 p-8 text-center shadow-lg backdrop-blur">
        <h1 className="text-2xl font-bold text-white">MONTALBANO</h1>
        <p className="mt-1 text-sm text-white/60">Operating System (MOS)</p>

        {ssoOn ? <SsoButton /> : <CredentialsForm />}
      </div>
    </div>
  );
}
