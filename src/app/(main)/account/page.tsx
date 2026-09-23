/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { redirect } from "next/navigation";
import AccountForm from "@/components/account/account-form";
import { requireReadOnlySession } from "@/lib/auth/session";
import { getUserById } from "@/lib/apps/access";

export default async function AccountPage() {
  const session = await requireReadOnlySession();
  const dbUser = await getUserById(session.user.id);
  if (!dbUser) redirect("/login");

  return (
    <section>
      <h1 className="text-2xl font-bold text-foreground">Account</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Update your display name and sign-in credentials.
      </p>
      <div className="mt-4">
        <AccountForm
          initialEmail={dbUser.email}
          initialDisplayName={dbUser.display_name}
        />
      </div>
    </section>
  );
}
