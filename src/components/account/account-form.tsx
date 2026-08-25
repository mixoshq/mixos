"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  updateDisplayName,
  updateEmail,
  updatePassword,
} from "@/lib/account/actions";
import {
  INITIAL_ACCOUNT_STATE,
  type AccountActionState,
} from "@/lib/account/state";

interface Props {
  initialEmail: string;
  initialDisplayName: string;
  passwordEnabled: boolean;
}

function Banner({ state }: { state: AccountActionState }) {
  if (state.error) {
    return (
      <p className="mt-2 rounded-md bg-rose-500/15 px-3 py-2 text-sm text-rose-700 dark:text-rose-400">
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p className="mt-2 rounded-md bg-emerald-500/15 px-3 py-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
        {state.success}
      </p>
    );
  }
  return null;
}

export default function AccountForm({
  initialEmail,
  initialDisplayName,
  passwordEnabled,
}: Props) {
  const router = useRouter();
  const { update: updateSession } = useSession();
  // Pin update() in a ref — useSession returns a new function reference on
  // every render, which would otherwise re-fire the effects below in a loop.
  const updateSessionRef = useRef(updateSession);
  updateSessionRef.current = updateSession;

  const [nameState, nameAction, namePending] = useActionState(
    updateDisplayName,
    INITIAL_ACCOUNT_STATE
  );
  const [emailState, emailAction, emailPending] = useActionState(
    updateEmail,
    INITIAL_ACCOUNT_STATE
  );
  const [pwState, pwAction, pwPending] = useActionState(
    updatePassword,
    INITIAL_ACCOUNT_STATE
  );

  // After a name or email change:
  //   - router.refresh() re-fetches RSC so the /account form (and any other
  //     visible server-rendered surface) shows the new value, including
  //     after a soft-nav back to this page.
  //   - updateSession() refreshes the NextAuth JWT so the header's
  //     useSession()-driven name updates without a sign-out.
  useEffect(() => {
    if (nameState.success) {
      console.log("[account-form] name save succeeded, refreshing session + router");
      updateSessionRef.current({});
      router.refresh();
    }
  }, [nameState, router]);
  useEffect(() => {
    if (emailState.success) {
      updateSessionRef.current({});
      router.refresh();
    }
  }, [emailState, router]);

  return (
    <div className="mt-8 space-y-6 rounded-lg border border-border bg-card p-6">
      <form action={nameAction} className="space-y-2">
        <label
          htmlFor="displayName"
          className="block text-sm font-medium text-foreground"
        >
          Display name
        </label>
        <div className="flex gap-2">
          <input
            id="displayName"
            name="displayName"
            type="text"
            required
            defaultValue={initialDisplayName}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-mixnavy focus:outline-none"
          />
          <button
            type="submit"
            disabled={namePending}
            className="rounded-md bg-mixnavy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-mixnavy/90 disabled:opacity-60"
          >
            {namePending ? "Saving…" : "Save"}
          </button>
        </div>
        <Banner state={nameState} />
      </form>

      <div className="border-t border-border pt-6">
        <form action={emailAction} className="space-y-2">
          <label
            htmlFor="email"
            className="block text-sm font-medium text-foreground"
          >
            Email
          </label>
          <div className="flex gap-2">
            <input
              id="email"
              name="email"
              type="email"
              required
              defaultValue={initialEmail}
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-mixnavy focus:outline-none"
            />
            <button
              type="submit"
              disabled={emailPending}
              className="rounded-md bg-mixnavy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-mixnavy/90 disabled:opacity-60"
            >
              {emailPending ? "Saving…" : "Save"}
            </button>
          </div>
          <Banner state={emailState} />
        </form>
      </div>

      {passwordEnabled ? (
        <div className="border-t border-border pt-6">
          <form action={pwAction} className="space-y-2">
            <p className="text-sm font-medium text-foreground">Change password</p>
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              placeholder="Current password"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-mixnavy focus:outline-none"
            />
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              placeholder="New password (min 10 characters)"
              required
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-mixnavy focus:outline-none"
            />
            <input
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              placeholder="Confirm new password"
              required
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-mixnavy focus:outline-none"
            />
            <button
              type="submit"
              disabled={pwPending}
              className="rounded-md bg-mixnavy px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-mixnavy/90 disabled:opacity-60"
            >
              {pwPending ? "Saving…" : "Update password"}
            </button>
            <Banner state={pwState} />
          </form>
        </div>
      ) : (
        <div className="border-t border-border pt-6">
          <p className="text-sm text-muted-foreground">
            Password login is disabled because an administrator has enabled SSO.
            Sign in with your identity provider instead.
          </p>
        </div>
      )}
    </div>
  );
}
