/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describeFloor, type FloorVerdict } from "@/lib/platform/version-floor";
import Notice from "../pending/notice";

/**
 * A release's `requiresMixOS` against this build, in the install dialog: a
 * line when it is met or can't be compared, and a warning when it isn't met,
 * since install refuses that release. Nothing for a release with no floor.
 *
 * The update dialog should show the floor of the release it would update to
 * with this too, from floorVerdict() on the server.
 */
export default function FloorNotice({
  floor,
  installable,
}: {
  floor: FloorVerdict;
  /** False where the dialog doesn't install, such as a built deployment, so there's nothing to upgrade first. */
  installable: boolean;
}) {
  if (!floor.declared) return null;
  if (floor.met) return <p className="text-sm text-muted-foreground">{describeFloor(floor)}</p>;
  return (
    <Notice tone="warning">
      {describeFloor(floor)}
      {installable && " Upgrade MixOS to install this release."}
    </Notice>
  );
}
