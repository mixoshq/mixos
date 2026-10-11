/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { formatLastUpdated } from "@/lib/apps/display";
import { isBuiltDeployment } from "@/lib/platform/build";
import { checkoutRoot } from "@/lib/repository/install";
import { listPendingInstalls, type PendingKind } from "@/lib/repository/pending";
import { pendingDisplayName } from "@/lib/repository/review";
import PendingInstallsList, { type PendingItem } from "./pending-installs-list";

/**
 * The pending installs of one kind in this checkout, for Admin > Apps or
 * Admin > Connectors.
 *
 * Read on the server, on every render, without a lock: the list is a view, and
 * Register and Discard check everything again under their locks. A built
 * deployment has no checkout, and so nothing pending: nothing is shown there.
 * The page that renders this has already required an admin.
 */
export default function PendingInstalls({ kind }: { kind: PendingKind }) {
  if (isBuiltDeployment()) return null;

  const root = checkoutRoot();
  const items: PendingItem[] = listPendingInstalls(root)
    .filter((p) => p.kind === kind)
    .map((p) => ({
      kind: p.kind,
      slug: p.slug,
      name: pendingDisplayName(root, p.kind, p.slug),
      path: p.path,
      version: p.record?.version ?? null,
      installed: p.sidecar
        ? `Installed ${formatLastUpdated(Date.parse(p.sidecar.installedAt))} by ${p.sidecar.installedBy}`
        : null,
      problem: p.problem,
      canRegister: p.problem === null,
      canDiscard: !p.sidecar?.register,
    }));

  return <PendingInstallsList kind={kind} items={items} />;
}
