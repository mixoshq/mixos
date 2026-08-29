/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useActionState, useEffect, useRef } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { adminCreateUser } from "@/lib/admin/user-actions";
import {
  INITIAL_ACCOUNT_STATE,
  type AccountActionState,
} from "@/lib/account/state";

const INPUT_CLASS =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring";

function Banner({ state }: { state: AccountActionState }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground"
      >
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p
        role="status"
        className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-foreground"
      >
        {state.success}
      </p>
    );
  }
  return null;
}

/**
 * Create an account before its holder has ever signed in.
 *
 * `sm` rather than the record dialog's `lg`: this is four fields and a
 * checkbox, and a form floating in a three-column panel reads as an unfinished
 * screen rather than a focused one.
 */
export default function AddUserDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState(
    adminCreateUser,
    INITIAL_ACCOUNT_STATE,
  );
  const formRef = useRef<HTMLFormElement>(null);

  /*
    Clear the form after a successful create, and stay open.

    Staying open is the point: adding people is something you do in a batch, and
    a dialog that closed after each one would make onboarding five users five
    round trips through the same button. The success banner names who was
    created, so the record of what just happened survives the reset.
  */
  useEffect(() => {
    if (state.success) formRef.current?.reset();
  }, [state.success]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      title="Add user"
      subtitle="Creates an account that can sign in immediately."
    >
      <form ref={formRef} action={action} className="space-y-4">
        <Field label="Display name" required>
          {(args) => (
            <input
              {...args}
              name="displayName"
              required
              maxLength={120}
              autoComplete="off"
              placeholder="Ada Lovelace"
              className={INPUT_CLASS}
            />
          )}
        </Field>

        <Field label="Email" required hint="This is how they sign in.">
          {(args) => (
            <input
              {...args}
              type="email"
              name="email"
              required
              autoComplete="off"
              placeholder="ada@example.com"
              className={INPUT_CLASS}
            />
          )}
        </Field>

        <Field
          label="Password"
          required
          hint="At least 10 characters. Give it to them over a channel you trust."
        >
          {(args) => (
            <input
              {...args}
              type="password"
              name="password"
              required
              minLength={10}
              autoComplete="new-password"
              className={INPUT_CLASS}
            />
          )}
        </Field>

        <Field label="Confirm password" required>
          {(args) => (
            <input
              {...args}
              type="password"
              name="confirmPassword"
              required
              minLength={10}
              autoComplete="new-password"
              className={INPUT_CLASS}
            />
          )}
        </Field>

        <label className="flex items-start gap-2.5 text-sm text-foreground">
          <input
            type="checkbox"
            name="isAdmin"
            className="mt-0.5 h-4 w-4 rounded border-input accent-primary"
          />
          <span>
            Make this user an administrator
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Administrators can reach every admin page, including connector
              credentials.
            </span>
          </span>
        </label>

        <Banner state={state} />

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" size="sm" onClick={onClose}>
            Done
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            busy={pending}
            busyLabel="Creating…"
          >
            Create user
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
