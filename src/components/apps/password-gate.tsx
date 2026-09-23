/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useActionState } from "react";
import { unlockApp, type UnlockState } from "@/app/(public)/unlock-action";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const INITIAL: UnlockState = { error: null };

interface PasswordGateProps {
  appName: string;
  appSlug: string;
  returnTo: string;
}

export default function PasswordGate({
  appName,
  appSlug,
  returnTo,
}: PasswordGateProps) {
  const [state, formAction, pending] = useActionState(unlockApp, INITIAL);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted px-4">
      <div className={cn(CARD_SHELL, "w-full max-w-sm p-5")}>
        <h1 className="text-lg font-semibold text-card-foreground">
          {appName}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          This page is password protected. Enter the app password to continue.
        </p>

        <form action={formAction} className="mt-6 space-y-4">
          <input type="hidden" name="appSlug" value={appSlug} />
          <input type="hidden" name="returnTo" value={returnTo} />

          <div>
            <label
              htmlFor="password"
              className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              autoFocus
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-ring focus:outline-none"
            />
          </div>

          {state.error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground"
            >
              {state.error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Unlocking…" : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
