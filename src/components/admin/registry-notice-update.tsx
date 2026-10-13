/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ExtensionKind } from "@/lib/repository/types";
import UpdateDialog, { type UpdateTarget } from "./update/update-dialog";

/**
 * Update, on the notice for an extension whose release was withdrawn or has a
 * newer one (./registry-notices.tsx). Shown in a checkout only: it opens the
 * update dialog, whose actions require an admin and check everything again.
 * The notice offers it and the admin decides; the update check never updates
 * anything itself.
 *
 * The dialog belongs to RegistryNoticeUpdates, which wraps the whole list of
 * notices, not to the button. The update's actions revalidate the page, so the
 * notices re-render while the dialog is open: once the release is downloaded
 * the notice says an update is waiting instead of offering the button, and
 * once it is registered the notice is gone. A dialog inside the button would
 * go with it, taking the result the admin is reading. The list's wrapper stays
 * where it is through both.
 */

const OpenUpdate = createContext<((target: UpdateTarget) => void) | null>(null);

/** Wraps the notices, and shows the update dialog any of their Update buttons opens. */
export function RegistryNoticeUpdates({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<UpdateTarget | null>(null);
  return (
    <OpenUpdate.Provider value={setTarget}>
      {children}
      {target && (
        <UpdateDialog key={`${target.kind}/${target.slug}`} target={target} onClose={() => setTarget(null)} />
      )}
    </OpenUpdate.Provider>
  );
}

export default function RegistryNoticeUpdate({
  kind,
  slug,
  name,
}: {
  kind: ExtensionKind;
  slug: string;
  name: string;
}) {
  const open = useContext(OpenUpdate);
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={open === null}
      onClick={() => open?.({ kind, slug, name })}
      aria-label={`Update ${name}`}
    >
      Update
    </Button>
  );
}
