/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { resetOnboarding } from "@/lib/onboarding/actions";
import { Card } from "@/components/ui/card";

/**
 * Clears the completion stamp and returns to the dashboard. The layout reads
 * the stamp on every request, so the refresh is what restarts the tour —
 * TourProvider sees `active` turn true and goes back to the first screen.
 */
export default function ReplayTourButton() {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleReplay() {
    startTransition(async () => {
      await resetOnboarding();
      router.push("/");
      router.refresh();
    });
  }

  return (
    // Half width, matching the Preferences card it sits directly beneath —
    // the two are one column on the page, so a full-width card here would
    // hang off the end of the stack.
    <Card className="mt-6 w-full p-4 shadow-sm md:w-1/2">
      <div className="mb-1 text-sm font-medium text-foreground">
        Welcome tour
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Replay the introduction you saw the first time you signed in.
      </p>
      <button
        type="button"
        onClick={handleReplay}
        disabled={isPending}
        className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
      >
        {isPending ? "Starting…" : "Replay welcome tour"}
      </button>
    </Card>
  );
}
