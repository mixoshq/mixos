/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useFormStatus } from "react-dom";
import { Loader2, Play } from "lucide-react";

/**
 * Submit button for the "Run now" form. Its own client component so
 * `useFormStatus` can show a pending spinner while the job runs inline (a
 * scheduled job can take up to the scheduler's job timeout to return).
 */
export default function RunNowButton({ disabled }: { disabled?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Play className="h-3 w-3" />
      )}
      {pending ? "Running…" : "Run now"}
    </button>
  );
}
