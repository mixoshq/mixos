/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useFormStatus } from "react-dom";
import { Loader2, Pause, Play } from "lucide-react";

/**
 * Submit button for the global scheduler switch. Its own client component so
 * `useFormStatus` can show a pending spinner while the toggle round-trips.
 * Label reflects the action: "Stop tick" when currently running, "Start tick"
 * when paused.
 */
export default function SchedulerToggleButton({ enabled }: { enabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
        enabled
          ? "border border-border hover:bg-muted"
          : "border border-transparent bg-primary text-primary-foreground hover:bg-primary/90"
      }`}
    >
      {pending ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : enabled ? (
        <Pause className="h-4 w-4" />
      ) : (
        <Play className="h-4 w-4" />
      )}
      {pending ? "Saving…" : enabled ? "Stop tick" : "Start tick"}
    </button>
  );
}
