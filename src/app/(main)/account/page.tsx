import { redirect } from "next/navigation";
import AccountForm from "@/components/account/account-form";
import { requireReadOnlySession } from "@/lib/auth/session";
import { getUserById } from "@/lib/apps/access";
import { isSsoEnabled } from "@/lib/auth/auth-config-store";

export default async function AccountPage() {
  const session = await requireReadOnlySession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) redirect("/login");

  const ssoOn = await isSsoEnabled();

  return (
    <section>
      <h2 className="text-lg font-semibold">Account</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Update your display name and{ssoOn ? " review the email used for SSO." : " sign-in credentials."}
      </p>
      <div className="mt-4">
        <AccountForm
          initialEmail={dbUser.email}
          initialDisplayName={dbUser.display_name}
          passwordEnabled={!ssoOn}
        />
      </div>
    </section>
  );
}
