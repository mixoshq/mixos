/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The sign-in fields, presentation only. The sign-in card renders them live;
 * the welcome tour renders them as an invisible ghost so its card is exactly
 * as tall as the sign-in card — which is what keeps the logo from moving
 * when the tour takes over. `ghost` makes them inert without changing their
 * size.
 */
export default function CredentialsFields({
  error = null,
  pending = false,
  ghost = false,
  email = "",
}: {
  error?: string | null;
  pending?: boolean;
  ghost?: boolean;
  email?: string;
}) {
  const inert = ghost ? { disabled: true, tabIndex: -1 } : {};
  return (
    <div className="space-y-4 text-left">
      <div>
        <label
          htmlFor={ghost ? undefined : "email"}
          className="mb-1 block text-xs font-medium uppercase tracking-wider text-white/60"
        >
          Email
        </label>
        <input
          id={ghost ? undefined : "email"}
          name="email"
          type="email"
          required
          autoComplete="email"
          defaultValue={email}
          className="w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
          placeholder="you@example.com"
          {...inert}
        />
      </div>

      <div>
        <label
          htmlFor={ghost ? undefined : "password"}
          className="mb-1 block text-xs font-medium uppercase tracking-wider text-white/60"
        >
          Password
        </label>
        <input
          id={ghost ? undefined : "password"}
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:border-white/40 focus:outline-none"
          {...inert}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/60 px-3 py-2 text-sm text-brand-foreground"
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={pending || ghost}
        tabIndex={ghost ? -1 : undefined}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-foreground px-4 py-2.5 text-sm font-medium text-brand shadow-sm transition-colors hover:bg-brand-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </div>
  );
}
