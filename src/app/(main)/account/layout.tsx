/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { redirect } from "next/navigation";
import { requireReadOnlySession } from "@/lib/auth/session";
import SettingsShell from "@/components/settings/settings-shell";

export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireReadOnlySession().catch(() => null);
  if (!session) redirect("/login");

  return <SettingsShell>{children}</SettingsShell>;
}
