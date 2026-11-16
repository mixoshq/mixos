/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { checkForReleasesNowAction } from "@/lib/platform/release-check-actions";

/**
 * Check now: a text button in the release check's muted line, styled as the
 * line's link after it, which it takes as `children`. It asks the server to
 * check (src/lib/platform/release-check-actions.ts), then refreshes the page,
 * so the line, and the notice when a newer release is out, come from the
 * stored answer as they always do. When the server didn't ask the catalogue,
 * it says why on a line of its own under the sentence, in a live region, since
 * nothing else on the page changes.
 */
export default function ReleaseCheckNow({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [checking, startChecking] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const check = () =>
    startChecking(async () => {
      setMessage(null);
      try {
        const result = await checkForReleasesNowAction();
        setMessage(result.message);
        if (result.refresh) router.refresh();
      } catch {
        setMessage("That didn't reach the server. Try again.");
      }
    });

  return (
    <>
      <button
        type="button"
        onClick={check}
        disabled={checking}
        className="underline underline-offset-2 hover:text-foreground disabled:cursor-wait disabled:no-underline"
      >
        {checking ? "Checking…" : "Check now"}
      </button>{" "}
      · {children}
      <span role="status" aria-live="polite" className="block">
        {message}
      </span>
    </>
  );
}
