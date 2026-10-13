/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { GitPullRequest } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExtensionKind } from "@/lib/repository/types";
import ProposeChangeDialog, { type ChangeTarget } from "./github/propose-change-dialog";
import UpdateDialog, { type UpdateTarget } from "./update/update-dialog";

/**
 * Update, on the notice for an extension whose release was withdrawn or has a
 * newer one (./registry-notices.tsx). Shown in a checkout only: it opens the
 * update dialog, whose actions require an admin and check everything again.
 * The notice offers it and the admin decides; the update check never updates
 * anything itself. On a built deployment with the GitHub App linked, the
 * notice offers Propose update instead, which opens the dialog that proposes
 * the update as a pull request (./github/propose-change-dialog.tsx).
 *
 * The dialogs belong to RegistryNoticeUpdates, which wraps the whole list of
 * notices, not to the buttons. The update's actions revalidate the page, so the
 * notices re-render while the dialog is open: once the release is downloaded
 * the notice says an update is waiting instead of offering the button, and
 * once it is registered the notice is gone. A dialog inside the button would
 * go with it, taking the result the admin is reading. The list's wrapper stays
 * where it is through both.
 */

interface Opens {
  update(target: UpdateTarget): void;
  propose(target: ChangeTarget, repository: string): void;
}

const OpenUpdate = createContext<Opens | null>(null);

/** Wraps the notices, and shows the dialog any of their Update or Propose update buttons opens. */
export function RegistryNoticeUpdates({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<UpdateTarget | null>(null);
  const [change, setChange] = useState<{ target: ChangeTarget; repository: string } | null>(null);
  const opens = useMemo<Opens>(
    () => ({ update: setTarget, propose: (target, repository) => setChange({ target, repository }) }),
    [],
  );
  return (
    <OpenUpdate.Provider value={opens}>
      {children}
      {target && (
        <UpdateDialog key={`${target.kind}/${target.slug}`} target={target} onClose={() => setTarget(null)} />
      )}
      {change && (
        <ProposeChangeDialog
          key={`propose:${change.target.kind}/${change.target.slug}`}
          target={change.target}
          repository={change.repository}
          onClose={() => setChange(null)}
        />
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
      onClick={() => open?.update({ kind, slug, name })}
      aria-label={`Update ${name}`}
    >
      Update
    </Button>
  );
}

/** Propose update: on a built deployment with the App linked, a pull request in place of the update. */
export function RegistryNoticePropose({
  kind,
  slug,
  name,
  repository,
  off,
}: {
  kind: ExtensionKind;
  slug: string;
  name: string;
  /** `owner/name`. */
  repository: string;
  /** Why proposing is off for now, or null. */
  off: string | null;
}) {
  const open = useContext(OpenUpdate);
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<GitPullRequest className="h-4 w-4 shrink-0" aria-hidden />}
      disabled={open === null || off !== null}
      onClick={() => open?.propose({ action: "update", kind, slug, name }, repository)}
      aria-label={`Propose update of ${name}`}
    >
      Propose update
    </Button>
  );
}
