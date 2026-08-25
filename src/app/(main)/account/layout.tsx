import { redirect } from "next/navigation";
import { requireReadOnlySession } from "@/lib/auth/session";
import AccountNav from "./account-nav";

export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireReadOnlySession().catch(() => null);
  if (!session) redirect("/login");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold">My Account</h1>
      <p className="mt-2 text-muted-foreground">
        Manage the account you sign in with, customize how MixOS looks and
        behaves for you, and connect personal accounts that widgets can read.
      </p>
      <div className="mt-8 grid grid-cols-1 gap-8 md:grid-cols-[200px_1fr]">
        <AccountNav />
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
