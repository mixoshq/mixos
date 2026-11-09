/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import TypedConfirmDialog from "@/components/admin/typed-confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Checkbox, Textarea } from "@/components/ui/input";
import {
  confirmBranchProtectionAction,
  confirmPreviewChecklistAction,
  forgetAppAction,
  unlinkAction,
  withdrawBranchProtectionAction,
  withdrawPreviewChecklistAction,
} from "@/lib/github/actions";
import type { GitHubOutcome } from "@/lib/github/outcomes";
import { OutcomeNotice, PREVIEW_ITEMS } from "./github-parts";

/**
 * Deployment > Production Updates's dialogs. Each closes with what its action answered, which
 * the page shows; a refusal it can say more about stays open to say it.
 */

type Close = (result: GitHubOutcome | null) => void;

const UNREACHED: GitHubOutcome = {
  ok: false,
  code: "error",
  message: "That didn't reach the server. Try again.",
  tone: "warning",
};

/**
 * Send a pasted key to the server. A POST to a route, with the CSRF token,
 * rather than a server action: `next dev` prints a server action's arguments
 * (src/app/api/admin/github/key/route.ts).
 */
async function sendKey(pem: string): Promise<GitHubOutcome> {
  const csrf = (await (await fetch("/api/auth/csrf", { credentials: "same-origin" })).json()) as { csrfToken?: string };
  const res = await fetch("/api/admin/github/key", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-csrf-token": csrf.csrfToken ?? "" },
    body: JSON.stringify({ pem }),
  });
  const outcome = (await res.json()) as GitHubOutcome;
  if (typeof outcome?.ok !== "boolean" || typeof outcome.message !== "string") throw new Error("unexpected answer");
  return outcome;
}

/** Paste a private key generated in the App's settings on GitHub. */
export function ReplaceKeyDialog({ appName, onClose }: { appName: string; onClose: Close }) {
  const [pem, setPem] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<GitHubOutcome | null>(null);

  const submit = async () => {
    setBusy(true);
    setRefusal(null);
    let result: GitHubOutcome;
    try {
      result = await sendKey(pem);
    } catch {
      result = UNREACHED;
    }
    setBusy(false);
    // The key is cleared either way: it shouldn't sit in the page.
    setPem("");
    if (result.ok) onClose(result);
    else setRefusal(result);
  };

  return (
    <Dialog
      open
      onClose={busy ? () => {} : () => onClose(null)}
      title="Replace private key"
      subtitle={appName}
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} busyLabel="Checking with GitHub…" disabled={!pem.trim()} onClick={submit}>
            Replace key
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-foreground">
          In the App&apos;s settings on GitHub, generate a private key, then paste the whole .pem file here. The
          instance checks with GitHub that the key is this App&apos;s before it stores it.
        </p>
        <p className="text-muted-foreground">
          GitHub has no API to create or delete an App&apos;s keys, so delete the old one there afterwards.
        </p>
        <Field label="Private key">
          {(field) => (
            <Textarea
              {...field}
              rows={8}
              value={pem}
              onChange={(e) => setPem(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-xs"
              placeholder="-----BEGIN RSA PRIVATE KEY-----"
            />
          )}
        </Field>
        {refusal && <OutcomeNotice outcome={refusal} />}
      </div>
    </Dialog>
  );
}

/** Uninstall the App on GitHub, then forget it here. */
export function UnlinkDialog({
  appName,
  repository,
  onClose,
}: {
  appName: string;
  repository: string | null;
  onClose: Close;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    let result: GitHubOutcome;
    try {
      result = await unlinkAction();
    } catch {
      result = UNREACHED;
    }
    setBusy(false);
    onClose(result);
  };

  return (
    <Dialog
      open
      onClose={busy ? () => {} : () => onClose(null)}
      title={repository ? `Unlink ${repository}?` : `Unlink ${appName}?`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" busy={busy} busyLabel="Uninstalling…" onClick={submit}>
            Uninstall and unlink
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-foreground">
        <p>
          This uninstalls {appName} from GitHub, then deletes its key and the link here. If GitHub refuses to
          uninstall it, nothing here is deleted.
        </p>
        <p className="text-muted-foreground">To finish, delete the App in its settings on GitHub.</p>
      </div>
    </Dialog>
  );
}

/** Forget an App whose key no longer works, without uninstalling it. */
export function ForgetDialog({ appName, slug, onClose }: { appName: string; slug: string; onClose: Close }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <TypedConfirmDialog
      onClose={() => onClose(null)}
      title={`Forget ${appName}?`}
      word={slug}
      confirmLabel="Forget without uninstalling"
      busyLabel="Forgetting…"
      busy={busy}
      error={error}
      onConfirm={async (typed) => {
        setBusy(true);
        setError(null);
        let result: GitHubOutcome;
        try {
          result = await forgetAppAction({ typedSlug: typed });
        } catch {
          result = UNREACHED;
        }
        setBusy(false);
        if (result.ok || result.code !== "typed") onClose(result);
        else setError(result.message);
      }}
    >
      <p className="text-foreground">
        Only for an App that was deleted on GitHub, or whose key can&apos;t be used any more. This instance
        can&apos;t uninstall it, so it forgets it as it is.
      </p>
      <p className="text-muted-foreground">
        If the App still exists, replace its private key and unlink instead, so it is uninstalled first.
      </p>
    </TypedConfirmDialog>
  );
}

/** A choice in the dialog below: a full-width button that wraps. */
const CHOICE = "h-auto w-full justify-start py-2 text-left";

/** Confirm that the default branch takes changes only through pull requests, by a protection the App can't read. */
export function OverrideDialog({
  repository,
  branch,
  onClose,
}: {
  repository: string;
  branch: string;
  onClose: Close;
}) {
  const [reason, setReason] = useState<"classic-protection" | "free-private" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!reason) {
    return (
      <Dialog
        open
        onClose={() => onClose(null)}
        title="Confirm another protection"
        subtitle={`${repository} · ${branch}`}
        size="sm"
        footer={
          <Button variant="ghost" onClick={() => onClose(null)}>
            Cancel
          </Button>
        }
      >
        <div className="space-y-3 text-sm text-foreground">
          <p>The App reads rulesets only. Which applies to {branch}?</p>
          <Button variant="secondary" className={CHOICE} onClick={() => setReason("classic-protection")}>
            Classic branch protection requires pull requests on it.
          </Button>
          <Button variant="secondary" className={CHOICE} onClick={() => setReason("free-private")}>
            It&apos;s a private repository on GitHub Free, which can&apos;t require pull requests.
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <TypedConfirmDialog
      onClose={() => onClose(null)}
      title="Confirm another protection"
      word={repository}
      confirmLabel="Confirm"
      busyLabel="Recording…"
      busy={busy}
      error={error}
      onConfirm={async (typed) => {
        setBusy(true);
        setError(null);
        let result: GitHubOutcome;
        try {
          result = await confirmBranchProtectionAction({ reason, typedRepository: typed });
        } catch {
          result = UNREACHED;
        }
        setBusy(false);
        if (result.ok || result.code !== "typed") onClose(result);
        else setError(result.message);
      }}
    >
      <p className="text-foreground">
        {reason === "classic-protection"
          ? `You confirm that classic branch protection requires a pull request for every change to ${branch}.`
          : `You accept that ${branch} can't be protected on GitHub Free, so only MixOS keeps the App's writes off it.`}
      </p>
      <p className="text-muted-foreground">The audit log records who confirmed it.</p>
    </TypedConfirmDialog>
  );
}

/** Withdraw the confirmation above. */
export function WithdrawOverrideButton({ onDone }: { onDone: (result: GitHubOutcome) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      busy={busy}
      busyLabel="Withdrawing…"
      onClick={async () => {
        setBusy(true);
        try {
          onDone(await withdrawBranchProtectionAction());
        } catch {
          onDone(UNREACHED);
        } finally {
          setBusy(false);
        }
      }}
    >
      Withdraw
    </Button>
  );
}

/** Confirm the preview checklist: every item ticked, or nothing is recorded. */
export function ChecklistDialog({ repository, onClose }: { repository: string; onClose: Close }) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<GitHubOutcome | null>(null);
  const all = PREVIEW_ITEMS.every((item) => ticked.has(item.id));

  const submit = async () => {
    setBusy(true);
    setRefusal(null);
    let result: GitHubOutcome;
    try {
      result = await confirmPreviewChecklistAction({ items: [...ticked] });
    } catch {
      result = UNREACHED;
    }
    setBusy(false);
    if (result.ok) onClose(result);
    else setRefusal(result);
  };

  return (
    <Dialog
      open
      onClose={busy ? () => {} : () => onClose(null)}
      title="Confirm previews are off"
      subtitle={repository}
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} busyLabel="Recording…" disabled={!all} onClick={submit}>
            Confirm
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-foreground">
          A preview of a branch runs its code with the host&apos;s secrets, and the App&apos;s branches carry a
          publisher&apos;s code. The instance reads your workflows, render.yaml and vercel.json itself. These live in
          the hosts&apos; own settings, where it can&apos;t look. Tick each one that holds.
        </p>
        <div className="space-y-3">
          {PREVIEW_ITEMS.map((item) => (
            <Checkbox
              key={item.id}
              label={item.text}
              checked={ticked.has(item.id)}
              onChange={(e) =>
                setTicked((s) => {
                  const next = new Set(s);
                  if (e.target.checked) next.add(item.id);
                  else next.delete(item.id);
                  return next;
                })
              }
            />
          ))}
        </div>
        <p className="text-muted-foreground">The audit log records who confirmed it.</p>
        {refusal && <OutcomeNotice outcome={refusal} />}
      </div>
    </Dialog>
  );
}

/** Withdraw the checklist's confirmation. */
export function WithdrawChecklistButton({ onDone }: { onDone: (result: GitHubOutcome) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      busy={busy}
      busyLabel="Withdrawing…"
      onClick={async () => {
        setBusy(true);
        try {
          onDone(await withdrawPreviewChecklistAction());
        } catch {
          onDone(UNREACHED);
        } finally {
          setBusy(false);
        }
      }}
    >
      Withdraw
    </Button>
  );
}
