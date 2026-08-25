"use client";

import { useActionState } from "react";
import { unlockApp, type UnlockState } from "@/app/(public)/unlock-action";

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
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-lg font-semibold text-gray-900">{appName}</h1>
        <p className="mt-1 text-sm text-gray-600">
          This page is password protected. Enter the app password to continue.
        </p>

        <form action={formAction} className="mt-6 space-y-4">
          <input type="hidden" name="appSlug" value={appSlug} />
          <input type="hidden" name="returnTo" value={returnTo} />

          <div>
            <label
              htmlFor="password"
              className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500"
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
              className="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-gray-500 focus:outline-none"
            />
          </div>

          {state.error && (
            <p
              role="alert"
              className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700"
            >
              {state.error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-gray-900 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Unlocking…" : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
