/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setAppActiveAction } from "@/lib/apps/admin-actions";

/**
 * Deactivate, on the notice for an app whose release was withdrawn
 * (./registry-notices.tsx).
 *
 * The app tile's own switch, through the same action: it requires an admin,
 * records `app.deactivate`, and is undone with Activate on Admin > Apps. The
 * notice offers it and the admin decides; the update check never switches
 * anything off itself.
 */
export default function RegistryNoticeDeactivate({ slug, name }: { slug: string; name: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function deactivate() {
    setError(null);
    startTransition(async () => {
      try {
        await setAppActiveAction(slug, false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <Button
        variant="secondary"
        size="sm"
        busy={pending}
        busyLabel="Deactivating…"
        onClick={deactivate}
        aria-label={`Deactivate ${name}`}
      >
        Deactivate
      </Button>
      <span className="text-xs text-muted-foreground">
        Turns it off for everyone here until an admin activates it again.
      </span>
      {error && (
        <p role="alert" className="w-full text-xs font-medium text-foreground">
          Couldn&apos;t deactivate it: {error}
        </p>
      )}
    </div>
  );
}
