/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use server";

/**
 * Check now, beside the release check's line under the build's version on the
 * admin pages (src/components/admin/release-check-now.tsx).
 *
 * A directly invocable POST endpoint, so it requires an admin before anything
 * else (docs/security-architecture.md §9). It takes no input. It runs the
 * scheduler tick's own check (./release-check.ts), with the same switch, lock
 * and request, and skips only the daily schedule: it still keeps to a minute
 * after the last attempt and to a wait the catalogue asked for
 * (`checkNowWaitsUntil()` in ./releases.ts), so pressing it again and again
 * sends one request a minute at most.
 *
 * It revalidates nothing itself. The button refreshes the page once it has
 * the answer, and the line and the notice read the stored answer again.
 */

import { requireAdmin } from "@/lib/apps/access";
import { requireReadOnlySession } from "@/lib/auth/session";
import { repositoryBaseUrl } from "@/lib/repository/client";
import { sourceHost } from "@/lib/repository/provenance";
import { readReleaseCheckState, runReleaseCheck } from "./release-check";
import { checkNowRefusal } from "./releases";

export interface CheckNowResult {
  /** Whether the stored answer may have changed, so the page should read it again. */
  refresh: boolean;
  /** What to tell the admin beside the line, when the line itself won't say it. */
  message: string | null;
}

/** Ask the catalogue for its releases now, unless it was asked under a minute ago or asked for a wait. */
export async function checkForReleasesNowAction(): Promise<CheckNowResult> {
  await requireAdmin(await requireReadOnlySession());

  try {
    switch (await runReleaseCheck({ manual: true })) {
      case "checked":
      case "failed":
        // The line says when it last heard from the catalogue, or since when
        // it couldn't reach it.
        return { refresh: true, message: null };
      case "off":
        return { refresh: true, message: "Release checks are off (MIXOS_UPDATE_CHECK)." };
      case "busy":
        return { refresh: false, message: "A check is already running. Its answer shows here when it's in." };
      case "not-due": {
        const host = sourceHost(repositoryBaseUrl());
        const now = new Date();
        return {
          refresh: false,
          message: checkNowRefusal(await readReleaseCheckState(), host, now) ?? "Checked a moment ago.",
        };
      }
    }
  } catch (err) {
    console.error("[release-check] Check now didn't run:", err);
    return { refresh: false, message: "The check didn't run. Try again." };
  }
}
