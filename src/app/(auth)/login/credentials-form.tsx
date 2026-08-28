/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useActionState } from "react";
import {
  signInWithCredentials,
  type CredentialsSignInState,
} from "./actions";

const INITIAL: CredentialsSignInState = { error: null };

export default function CredentialsForm() {
  const [state, formAction, pending] = useActionState(
    signInWithCredentials,
    INITIAL
  );

  return (
    <form action={formAction} className="mt-8 space-y-4 text-left">
      <div>
        <label
          htmlFor="email"
          className="mb-1 block text-xs font-medium uppercase tracking-wider text-white/60"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          className="w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
          placeholder="you@example.com"
        />
      </div>

      <div>
        <label
          htmlFor="password"
          className="mb-1 block text-xs font-medium uppercase tracking-wider text-white/60"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
        />
      </div>

      {state.error && (
        <p className="rounded-md border border-destructive/60 px-3 py-2 text-sm text-brand-foreground">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-foreground px-4 py-2.5 text-sm font-medium text-brand shadow-sm transition-colors hover:bg-brand-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
