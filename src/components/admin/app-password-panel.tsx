/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useEffect, useState, useTransition } from "react";
import { AlertCircle, Check } from "lucide-react";
import {
  clearAppPasswordAction,
  getAppPasswordStatus,
  setAppPasswordAction,
  type AppPasswordStatus,
} from "@/lib/apps/admin-actions";

interface Props {
  slug: string;
  appName: string;
}

/**
 * Admin-only panel for managing the app-wide unlock password. Shown on the
 * Access tab of the app's details dialog, for an app with any `pageVisibility`
 * or `apiVisibility` entry set to `"password"`. The hash is never exposed — we only fetch
 * whether one exists and when it was last updated. Existing 24h unlock
 * cookies remain valid after a rotation (they're stateless signed tokens);
 * clearing the password is the only way to force fail-closed immediately.
 */
export default function AppPasswordPanel({ slug, appName }: Props) {
  const [status, setStatus] = useState<AppPasswordStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [pwd, setPwd] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    getAppPasswordStatus(slug)
      .then(setStatus)
      .catch((e) => setStatusError(e instanceof Error ? e.message : String(e)));
  }, [slug]);

  function handleSet(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    setActionError(null);
    setActionSuccess(null);
    if (pwd.length < 8) {
      setActionError("Password must be at least 8 characters.");
      return;
    }
    startTransition(async () => {
      try {
        await setAppPasswordAction(slug, pwd);
        setPwd("");
        setActionSuccess(
          status?.set
            ? "Password updated. Existing unlock sessions remain valid up to 24h."
            : "Password set. Visitors can now unlock the app.",
        );
        const next = await getAppPasswordStatus(slug);
        setStatus(next);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Action failed");
      }
    });
  }

  function handleClear() {
    setActionError(null);
    setActionSuccess(null);
    startTransition(async () => {
      try {
        await clearAppPasswordAction(slug);
        setActionSuccess(
          "Password cleared. Password-protected pages will fail closed until a new one is set.",
        );
        const next = await getAppPasswordStatus(slug);
        setStatus(next);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Action failed");
      }
    });
  }

  return (
    <div
      className="mt-3 rounded-lg border border-border bg-background p-3"
      onClick={(e) => e.stopPropagation()}
    >
      <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        App Password
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        One shared password gates every page and API route marked
        <code className="mx-1 rounded bg-muted px-1 py-0.5">password</code>
        in <span className="font-semibold">{appName}</span>. Visitors stay
        unlocked for 24h via a slug-scoped cookie.
      </p>

      {statusError ? (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{statusError}</span>
        </p>
      ) : status === null ? (
        <p className="mt-2 text-xs text-muted-foreground">Loading status…</p>
      ) : (
        <p className="mt-2 text-xs">
          {status.set ? (
            <span className="text-success">
              <Check className="mr-1 inline-block h-3 w-3" />
              Password is set
              {status.updatedAt && (
                <span className="ml-1 text-muted-foreground">
                  (updated {new Date(status.updatedAt).toLocaleString()})
                </span>
              )}
            </span>
          ) : (
            <span className="text-warning">
              <AlertCircle className="mr-1 inline-block h-3 w-3" />
              No password set — password-protected pages will fail closed.
            </span>
          )}
        </p>
      )}

      <form
        onSubmit={handleSet}
        className="mt-3 flex flex-wrap items-end gap-2"
      >
        <div className="flex-1 min-w-[16rem]">
          <label
            htmlFor={`pwd-${slug}`}
            className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
          >
            {status?.set ? "New password" : "Set password"}
          </label>
          <input
            id={`pwd-${slug}`}
            type="password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            placeholder="Min. 8 characters"
            className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus:border-ring focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={pending || !pwd}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground shadow-sm hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Saving…" : status?.set ? "Update" : "Set"}
        </button>
        {status?.set && (
          <button
            type="button"
            onClick={handleClear}
            disabled={pending}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-60"
          >
            Clear
          </button>
        )}
      </form>

      {actionError && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{actionError}</span>
        </p>
      )}
      {actionSuccess && (
        <p className="mt-2 text-xs text-success">{actionSuccess}</p>
      )}
    </div>
  );
}
