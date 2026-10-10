/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import SettingsShell from "@/components/settings/settings-shell";
import { ToastProvider } from "@/components/ui/toast";

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The toast viewport is mounted here rather than at the root: admin actions
    // are the ones that finish somewhere other than where you are looking —
    // applying a theme repaints the whole page, so the confirmation cannot be
    // an inline notice on the tile you just left.
    //
    // `showBuild`: the admin pages are where the MixOS version and commit are
    // shown, and the only place they are.
    <ToastProvider>
      <SettingsShell showBuild>{children}</SettingsShell>
    </ToastProvider>
  );
}
