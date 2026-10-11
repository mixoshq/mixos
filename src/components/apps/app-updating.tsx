/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { CARD_SHELL } from "@/components/ui/card";
import { APP_UPDATING_MESSAGE } from "@/lib/platform/maintenance-gate";
import { cn } from "@/lib/utils";

/**
 * What an app's page shows in its place while the app's own migrations are
 * behind this build (src/lib/apps/app-gate.ts), rendered without importing
 * the page.
 *
 * The proxy normally answers first, in the same words, with a 503
 * (src/lib/platform/maintenance-gate.ts). This is the page route's own answer
 * for a request that reached it anyway, such as one whose proxy hadn't yet
 * caught up with the update. A page can't set its status, so it is a 200.
 *
 * `fullScreen` for the public surface, which has no chrome around it.
 */
export default function AppUpdating({ fullScreen = false }: { fullScreen?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center px-4",
        fullScreen ? "min-h-screen bg-muted" : "py-16",
      )}
    >
      <div className={cn(CARD_SHELL, "max-w-sm p-5 text-center")}>
        <h1 className="text-lg font-semibold text-card-foreground">Being updated</h1>
        <p className="mt-2 text-sm text-muted-foreground">{APP_UPDATING_MESSAGE}</p>
      </div>
    </div>
  );
}
