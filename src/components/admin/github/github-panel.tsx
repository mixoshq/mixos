/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import Notice from "@/components/ui/notice";
import { StatusPill } from "@/components/ui/status";
import { checkLinkAction, finishLinkingAction } from "@/lib/github/actions";
import type { GitHubOutcome, GitHubPageState } from "@/lib/github/outcomes";
import CreateApp from "./create-app";
import { Fact, GitHubLink, OVERRIDE_TEXT, OutcomeNotice, PREVIEW_ITEMS, when } from "./github-parts";
import {
  ChecklistDialog,
  ForgetDialog,
  OverrideDialog,
  ReplaceKeyDialog,
  UnlinkDialog,
  WithdrawChecklistButton,
  WithdrawOverrideButton,
} from "./github-dialogs";

/** "Install on GitHub", a link dressed as the small secondary button beside it. */
const INSTALL_LINK =
  "inline-flex h-9 items-center gap-1.5 rounded-md bg-secondary px-3 text-sm font-medium " +
  "text-secondary-foreground hover:bg-secondary/80";

/** The answers that mean the App's key can't be used: then Forget is offered. */
const KEY_UNUSABLE = new Set(["key-refused", "key-unreadable", "github-unauthorized"]);

/**
 * Deployment > GitHub App: create the App, install it, link it, and look after the
 * link. Everything shown comes from the server's read of this instance
 * (src/lib/github/page-state.ts); the buttons run the actions in
 * src/lib/github/actions.ts, each of which checks the admin again.
 */
export default function GitHubPanel({
  state,
  installedHint,
}: {
  state: GitHubPageState;
  /** The installation id GitHub's redirect carried, if it did. */
  installedHint: number | null;
}) {
  const [outcome, setOutcome] = useState<GitHubOutcome | null>(null);
  const [busy, setBusy] = useState<"finish" | "check" | null>(null);
  const [dialog, setDialog] = useState<"replace" | "unlink" | "forget" | "override" | "checklist" | null>(null);
  const router = useRouter();

  const run = async (which: "finish" | "check", action: () => Promise<GitHubOutcome>) => {
    setBusy(which);
    setOutcome(null);
    try {
      setOutcome(await action());
    } finally {
      setBusy(null);
    }
  };
  const closeWith = (result: GitHubOutcome | null) => {
    setDialog(null);
    if (result) setOutcome(result);
    // The key goes through a route, not a server action, so nothing else
    // re-renders the page with what it changed.
    if (result?.ok) router.refresh();
  };

  if (state.corrupt) {
    return (
      <Notice tone="danger" title="The stored GitHub link can't be read">
        Nothing will use it. The rows are the <code className="font-mono text-xs">github_*</code> keys in{" "}
        <code className="font-mono text-xs">platform_settings</code>.
      </Notice>
    );
  }

  if (state.feature !== "on") {
    return (
      <div className="space-y-4">
        {state.feature === "off" ? (
          <Notice tone="info" title="The GitHub App is off">
            <p>
              To turn it on, set <code className="font-mono text-xs">GITHUB_APP_ENCRYPTION_KEY</code> where this
              instance runs, to 32 random bytes, and restart it. This prints one:
            </p>
            <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-xs">
              npm run keys:generate -- --github-app
            </pre>
            <p className="mt-2">The App&apos;s private key is stored encrypted under it, so keep a copy.</p>
          </Notice>
        ) : (
          <Notice tone="danger" title="GITHUB_APP_ENCRYPTION_KEY isn't a key">
            It has to be 32 random bytes, as 64 hex characters or as base64. The GitHub App is off until it is.
          </Notice>
        )}
        {state.app && (
          <p className="text-sm text-muted-foreground">
            An App is recorded here, {state.app.name}. Turn the key back on to manage or unlink it.
          </p>
        )}
      </div>
    );
  }

  const { app, link } = state;
  const appCard = app && (
    <Card as="section">
      <CardHeader title="App" description="Private to its owner, and installed on one repository." />
      <CardBody>
        <dl className="divide-y divide-border">
          <Fact label="Name">
            <GitHubLink href={app.settingsUrl}>{app.name}</GitHubLink>
          </Fact>
          <Fact label="Owner">
            {app.owner} {app.ownerType === "Organization" ? "(organization)" : ""}
          </Fact>
          <Fact label="Private key">
            <code className="break-all font-mono text-xs">{app.keyFingerprint}</code>
            {!app.keyReadable && (
              <span className="mt-1 block">
                <StatusPill tone="danger">Can&apos;t be read</StatusPill>{" "}
                <span className="text-muted-foreground">
                  It doesn&apos;t decrypt with GITHUB_APP_ENCRYPTION_KEY. Re-encrypt it with the old key, or replace it.
                </span>
              </span>
            )}
          </Fact>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => setDialog("replace")}>
            Replace private key
          </Button>
          <Button variant="destructive" size="sm" onClick={() => setDialog("unlink")}>
            Unlink
          </Button>
          {(!app.keyReadable || (outcome && !outcome.ok && KEY_UNUSABLE.has(outcome.code))) && (
            <Button variant="ghost" size="sm" onClick={() => setDialog("forget")}>
              Forget without uninstalling
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );

  return (
    <div className="space-y-6">
      {outcome && <OutcomeNotice outcome={outcome} />}

      {!app && <CreateApp origin={state.origin} defaultName={state.defaultName} />}

      {app && !link && (
        <Card as="section">
          <CardHeader
            title="Install the App"
            description="Step 2 of 3, on GitHub. Then step 3, here."
          />
          <CardBody>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-foreground">
              <li>
                Install {app.name} on the one repository this instance is built from. On GitHub, choose{" "}
                <strong>Only select repositories</strong>, then that repository.
              </li>
              <li>GitHub sends you back here. Finish linking, and the instance checks what GitHub installed.</li>
            </ol>
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href={app.installUrl}
                className={INSTALL_LINK}
              >
                Install on GitHub
                <ExternalLink className="h-4 w-4" aria-hidden />
              </a>
              <Button
                variant={installedHint ? "primary" : "secondary"}
                size="sm"
                busy={busy === "finish"}
                busyLabel="Checking with GitHub…"
                onClick={() =>
                  run("finish", () => finishLinkingAction(installedHint ? { installationId: installedHint } : {}))
                }
              >
                Finish linking
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {link && (
        <>
          {link.disabled && (
            <Notice tone="danger" title="The link is off">
              <p className="break-words">{link.disabled.detail}</p>
              <p className="mt-1">
                Nothing uses the App until the installation covers only {link.repository.fullName} again. Narrow
                it on GitHub, then check again, or unlink.
              </p>
              <p className="mt-2">
                <GitHubLink href={link.installationUrl}>Installation settings on GitHub</GitHubLink>
              </p>
            </Notice>
          )}

          <Card as="section">
            <CardHeader
              title="Repository"
              right={
                link.disabled ? (
                  <StatusPill tone="danger">Off</StatusPill>
                ) : (
                  <StatusPill tone="success">Linked</StatusPill>
                )
              }
            />
            <CardBody>
              <dl className="divide-y divide-border">
                <Fact label="Repository">
                  <GitHubLink href={link.repository.url}>{link.repository.fullName}</GitHubLink>{" "}
                  <span className="text-muted-foreground">
                    ({link.repository.private ? "private" : "public"}
                    {link.repository.fork
                      ? `, a fork of ${link.repository.parent ?? "another repository"}`
                      : ", not a fork"}
                    )
                  </span>
                </Fact>
                <Fact label="Default branch">
                  <code className="font-mono text-xs">{link.repository.defaultBranch}</code>
                </Fact>
                <Fact label="Installation">
                  <GitHubLink href={link.installationUrl}>{String(link.installationId)}</GitHubLink>
                </Fact>
                <Fact label="Linked">{when(link.linkedAt)}</Fact>
                <Fact label="Last checked">{when(link.checkedAt)}</Fact>
              </dl>
              <p className="mt-3 text-sm text-muted-foreground">
                Every operation checks the installation again first, and turns the link off if it covers more than
                this one repository.
              </p>
              <div className="mt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  busy={busy === "check"}
                  busyLabel="Checking with GitHub…"
                  onClick={() => run("check", checkLinkAction)}
                >
                  Check again
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card as="section">
            <CardHeader
              title="Branch rule"
              right={
                state.branchRule?.pullRequest ? (
                  <StatusPill tone="success">Pull requests required</StatusPill>
                ) : state.override ? (
                  <StatusPill tone="warning">Confirmed by an admin</StatusPill>
                ) : state.branchRule?.unreadStatus ? (
                  <StatusPill tone="warning">Rules not readable</StatusPill>
                ) : (
                  <StatusPill tone="warning">No rule found</StatusPill>
                )
              }
            />
            <CardBody>
              {state.branchRule?.unreadStatus ? (
                <p className="text-sm text-foreground">
                  GitHub didn&apos;t let the App read the rules on {state.branchRule.branch} (it answered{" "}
                  {state.branchRule.unreadStatus}). A private repository on GitHub Free has no rulesets: confirm
                  another protection below, or make sure rulesets are available and check again.
                </p>
              ) : state.branchRule ? (
                <p className="text-sm text-foreground">
                  {state.branchRule.pullRequest
                    ? `A pull_request rule applies to ${state.branchRule.branch}.`
                    : `No pull_request rule applies to ${state.branchRule.branch}.`}{" "}
                  <span className="text-muted-foreground">
                    Read {when(state.branchRule.checkedAt)}
                    {state.branchRule.rules.length > 0 ? `: ${state.branchRule.rules.join(", ")}.` : "."}
                  </span>
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">Not read yet. Check again to read it.</p>
              )}
              {!state.branchRule?.pullRequest && (
                <div className="mt-3 space-y-2 text-sm text-foreground">
                  <p>
                    The App can write to any branch, so the default branch, which your host deploys, should take
                    changes only through pull requests. Add rulesets on GitHub:
                  </p>
                  <ul className="list-disc space-y-1 pl-5">
                    <li>on the default branch, require a pull request before merging, and restrict deletions;</li>
                    <li>on all tags, restrict creations and updates;</li>
                    <li>and keep the App off both bypass lists.</li>
                  </ul>
                  <p className="text-muted-foreground">
                    Linking doesn&apos;t need it; proposing changes through the App will. The App reads rulesets
                    only, so classic branch protection doesn&apos;t show here.
                  </p>
                  <p>
                    <GitHubLink href={link.rulesetsUrl}>Rulesets on GitHub</GitHubLink>
                  </p>
                </div>
              )}
              {state.override ? (
                <div className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-sm">
                  <p className="text-foreground">{OVERRIDE_TEXT[state.override.reason]}</p>
                  <p className="mt-1 text-muted-foreground">
                    Confirmed by {state.override.by}, {when(state.override.at)}.
                  </p>
                  <div className="mt-2">
                    <WithdrawOverrideButton onDone={(r) => setOutcome(r)} />
                  </div>
                </div>
              ) : (
                !state.branchRule?.pullRequest &&
                !link.disabled && (
                  <div className="mt-4">
                    <Button variant="ghost" size="sm" onClick={() => setDialog("override")}>
                      Confirm another protection
                    </Button>
                  </div>
                )
              )}
            </CardBody>
          </Card>

          <Card as="section">
            <CardHeader
              title="Previews elsewhere"
              right={
                state.previewChecklist ? (
                  <StatusPill tone="success">Confirmed</StatusPill>
                ) : (
                  <StatusPill tone="warning">Not confirmed</StatusPill>
                )
              }
            />
            <CardBody>
              <p className="text-sm text-foreground">
                On a deployment, Browse proposes an extension, and the release notice an update of MixOS, as a pull
                request from a branch under <code className="font-mono text-xs">mixos/</code>. Before each one, the
                instance reads your workflows, <code className="font-mono text-xs">render.yaml</code> and, on Vercel,{" "}
                <code className="font-mono text-xs">vercel.json</code>, and refuses if any would build that branch
                with secrets. It can&apos;t read hosts&apos; own settings, so proposals also need you to confirm:
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-foreground">
                {PREVIEW_ITEMS.map((item) => (
                  <li key={item.id}>{item.text}</li>
                ))}
              </ul>
              {state.previewChecklist ? (
                <div className="mt-4 rounded-md border border-border bg-muted px-3 py-2 text-sm">
                  <p className="text-muted-foreground">
                    Confirmed by {state.previewChecklist.by}, {when(state.previewChecklist.at)}.
                  </p>
                  <div className="mt-2">
                    <WithdrawChecklistButton onDone={(r) => setOutcome(r)} />
                  </div>
                </div>
              ) : (
                !link.disabled && (
                  <div className="mt-4">
                    <Button variant="secondary" size="sm" onClick={() => setDialog("checklist")}>
                      Confirm
                    </Button>
                  </div>
                )
              )}
            </CardBody>
          </Card>
        </>
      )}

      {appCard}

      {app && dialog === "replace" && <ReplaceKeyDialog appName={app.name} onClose={closeWith} />}
      {app && dialog === "unlink" && (
        <UnlinkDialog appName={app.name} repository={link?.repository.fullName ?? null} onClose={closeWith} />
      )}
      {app && dialog === "forget" && <ForgetDialog appName={app.name} slug={app.slug} onClose={closeWith} />}
      {link && dialog === "checklist" && (
        <ChecklistDialog repository={link.repository.fullName} onClose={closeWith} />
      )}
      {link && dialog === "override" && (
        <OverrideDialog
          repository={link.repository.fullName}
          branch={link.repository.defaultBranch}
          onClose={closeWith}
        />
      )}
    </div>
  );
}
