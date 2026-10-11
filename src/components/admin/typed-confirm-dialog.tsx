/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

/**
 * A confirmation that acts only once a name has been typed: activating an app,
 * or enabling a connector, that the release step found under a name a
 * different extension had. A typed name can't be clicked through on habit the
 * way a second button can, and the server checks it too.
 *
 * Mount it while it is open: it starts empty each time.
 */
export default function TypedConfirmDialog({
  onClose,
  title,
  word,
  confirmLabel,
  busyLabel,
  busy,
  error,
  onConfirm,
  children,
}: {
  onClose: () => void;
  title: string;
  /** What has to be typed: an app's slug, or a connector's name. */
  word: string;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  /** Why the last attempt failed, if it did. */
  error?: string | null;
  onConfirm: (typed: string) => void;
  children: ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === word;
  const confirm = () => {
    if (matches && !busy) onConfirm(typed.trim());
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={confirm}
            disabled={!matches}
            busy={busy}
            busyLabel={busyLabel}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          confirm();
        }}
      >
        {children}
        <Field label={`Type ${word} to confirm`} error={error ?? undefined}>
          {(field) => (
            <Input
              {...field}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="font-mono"
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
