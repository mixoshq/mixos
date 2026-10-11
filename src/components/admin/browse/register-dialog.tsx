/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import Notice from "@/components/ui/notice";
import {
  installExtensionAction,
  resolveInstallAction,
  type InstallOutcome,
} from "@/lib/repository/actions";
import type {
  Extension,
  ExtensionSummary,
  InstallManifest,
} from "@/lib/repository/types";
import { KIND_LABEL } from "@/lib/repository/types";
import { leftOutLine } from "@/lib/repository/left-out";
import HandBackPanel from "../pending/hand-back";
import type { PendingTarget } from "../pending/review-dialog";

/**
 * The confirmation step for an install from the catalogue.
 *
 * An app or a connector installs into `.mixos/pending/`, where none of its
 * code runs, and its result leads to the review that comes before Register
 * (../pending/review-dialog.tsx). A theme has no code, and registers as it
 * installs.
 *
 * ── WHY THIS IS A DIALOG AND NOT A ONE-CLICK BUTTON ─────────────────────────
 *
 * Installing copies third-party code into this instance's source tree and
 * makes it installable by everyone on the deployment. The facts that decide
 * whether that is a good idea — which commit, which checksum, what the
 * publisher says it will reach — are exactly the facts a one-click button
 * hides. An admin who has approved "the latest version" has approved a moving
 * target; one who has been shown a 40-character commit and a `sha256-` digest
 * has approved a specific set of bytes.
 *
 * ── THE PERMISSIONS LIST IS LABELLED AS A CLAIM ─────────────────────────────
 *
 * What is shown here is what the PUBLISHER wrote on their listing. What this
 * instance enforces comes from the manifest inside the downloaded package,
 * after the registry checks have run on it. The two can disagree, and if they
 * do the manifest wins — so the dialog says whose words these are rather than
 * presenting them as a guarantee it is not in a position to make.
 */
export default function RegisterDialog({
  extension,
  notInstallable = null,
  onClose,
  onInstalled,
  onReview,
}: {
  extension: ExtensionSummary | null;
  /**
   * Why this deployment doesn't install, when it doesn't: the dialog still
   * shows the release, and says this in place of offering to install it.
   */
  notInstallable?: { message: string; tone: "info" | "warning" } | null;
  onClose: () => void;
  /**
   * Told once it is installed, whether it waits in pending, and its version,
   * so the grid can flip the tile: to where it came from for a theme, to the
   * review otherwise.
   */
  onInstalled: (extension: ExtensionSummary, pending: boolean, version: string) => void;
  /** Go on to the review of the pending install, which leads to Register. */
  onReview: (target: PendingTarget) => void;
}) {
  const [manifest, setManifest] = useState<InstallManifest | null>(null);
  const [listing, setListing] = useState<Extension | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null);
  const [acceptYanked, setAcceptYanked] = useState(false);

  const slug = extension?.slug ?? null;
  const kind = extension?.kind ?? null;

  /*
    Resolve on mount, and only that.

    There is no state reset here because there is no state to reset: the browser
    keys this component on the chosen extension, so picking a different one
    mounts a fresh instance rather than reusing this one with someone else's
    manifest, error and outcome still in it. Resetting four pieces of state at
    the top of an effect is the version of this that has to be kept in step with
    every field added later, and it is a cascading render besides.
  */
  useEffect(() => {
    if (!kind || !slug) return;
    let live = true;
    void resolveInstallAction({ kind, slug }).then((res) => {
      if (!live) return;
      // The listing arrives either way — see the action's note on why a failed
      // manifest must not take the context down with it.
      setListing(res.listing);
      if (res.ok) setManifest(res.manifest);
      else setResolveError(res.message);
    });
    return () => {
      live = false;
    };
  }, [kind, slug]);

  const register = useCallback(async () => {
    if (!kind || !slug) return;
    setBusy(true);
    try {
      const res = await installExtensionAction({
        kind,
        slug,
        version: manifest?.version,
        allowYanked: acceptYanked,
      });
      setOutcome(res);
      if (res.ok && extension) onInstalled(extension, res.result.pending, res.result.version);
    } finally {
      setBusy(false);
    }
  }, [kind, slug, extension, manifest?.version, acceptYanked, onInstalled]);

  if (!extension || !kind) return null;

  const yanked = manifest?.yanked === true;
  const blocked = yanked && !acceptYanked;
  // Another registration held the lock, so nothing happened yet. The dialog
  // stays on the same release, with the same answers, and offers it again.
  const locked = outcome?.ok === false && outcome.code === "locked";

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        outcome?.ok
          ? `${extension.name} installed`
          : `Install ${extension.name}`
      }
      subtitle={
        outcome && !locked
          ? undefined
          : listing
            ? `${KIND_LABEL[kind].one} · ${listing.sourceRepo.owner}/${listing.sourceRepo.name}`
            : `${KIND_LABEL[kind].one} · ${extension.slug}`
      }
      size="lg"
      footer={
        outcome?.ok && outcome.result.pending ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Later
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                onReview({
                  kind: outcome.result.kind as PendingTarget["kind"],
                  slug: outcome.result.slug,
                  name: extension.name,
                })
              }
            >
              Review and register
            </Button>
          </>
        ) : (outcome && !locked) || notInstallable ? (
          <Button variant="primary" onClick={onClose}>
            {notInstallable && !outcome ? "Close" : "Done"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              busyLabel="Verifying and installing…"
              disabled={!manifest || blocked}
              onClick={register}
            >
              {locked ? "Try again" : "Verify and install"}
            </Button>
          </>
        )
      }
    >
      {notInstallable && !outcome && (
        <div className="mb-5">
          <Notice tone={notInstallable.tone}>{notInstallable.message}</Notice>
        </div>
      )}
      {outcome ? (
        <OutcomePanel outcome={outcome} />
      ) : resolveError ? (
        <div className="space-y-4">
          <Notice
            tone="danger"
            icon={<XCircle className="h-4 w-4" aria-hidden />}
          >
            {resolveError}
          </Notice>
          {listing && (
            <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              <Row label="Source">
                <a
                  href={listing.sourceRepo.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline underline-offset-2"
                >
                  {listing.sourceRepo.owner}/{listing.sourceRepo.name}
                </a>
              </Row>
              {listing.latestVersion && (
                <Row label="Latest">{listing.latestVersion}</Row>
              )}
            </dl>
          )}
        </div>
      ) : !manifest ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Asking the repository how to install this…
        </p>
      ) : (
        <div className="space-y-5">
          {yanked && !notInstallable && (
            <Notice
              tone="warning"
              icon={<AlertTriangle className="h-4 w-4" aria-hidden />}
            >
              <p className="font-medium">
                Version {manifest.version} has been withdrawn by its publisher.
              </p>
              {manifest.yankedReason && (
                <p className="mt-1">{manifest.yankedReason}</p>
              )}
              <Checkbox
                className="mt-3"
                label="Install it anyway."
                checked={acceptYanked}
                onChange={(e) => setAcceptYanked(e.target.checked)}
              />
            </Notice>
          )}

          <section>
            <h3 className="text-sm font-semibold text-foreground">
              What will be fetched and verified
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              The code is downloaded from GitHub at the exact commit below, not
              from mixos.org. It is only written to this instance if its
              checksum matches what the repository published.
            </p>
            <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              <Row label="Version">
                {manifest.version}
                {manifest.gitTag && (
                  <span className="text-muted-foreground">
                    {" "}
                    ({manifest.gitTag})
                  </span>
                )}
              </Row>
              {listing && (
                <Row label="Source">
                  <a
                    href={listing.sourceRepo.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline underline-offset-2"
                  >
                    {listing.sourceRepo.owner}/{listing.sourceRepo.name}
                  </a>
                </Row>
              )}
              <Row label="Commit">
                <code className="break-all font-mono text-xs">
                  {manifest.commitSha}
                </code>
              </Row>
              <Row label="Checksum">
                <code className="break-all font-mono text-xs">
                  {manifest.contentHash}
                </code>
              </Row>
              {manifest.subpath && (
                <Row label="Subdirectory">
                  <code className="font-mono text-xs">{manifest.subpath}</code>
                </Row>
              )}
              <Row label="Installs to">
                {kind === "theme" ? (
                  <code className="font-mono text-xs">themes/{manifest.slug}</code>
                ) : (
                  <>
                    <code className="font-mono text-xs">
                      .mixos/pending/{kind === "connector" ? "connectors" : "apps"}/
                      {manifest.slug}
                    </code>
                    <span className="text-muted-foreground">
                      {" "}
                      until you register it
                    </span>
                  </>
                )}
              </Row>
            </dl>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground">
              What the publisher says it needs
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Declared on the mixos.org listing. What this instance actually
              enforces comes from the manifest inside the package, once the
              registry checks have run on it.
            </p>
            {manifest.permissions.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No permissions declared.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {manifest.permissions.map((p) => (
                  <li key={p.scope} className="text-sm">
                    <code className="font-mono text-xs text-foreground">
                      {p.scope}
                    </code>
                    <span className="ml-2 text-muted-foreground">
                      {p.reason}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {manifest.requiresMixOS && (
            <p className="text-sm text-muted-foreground">
              Requires MixOS {manifest.requiresMixOS} or newer.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}

/**
 * The result.
 *
 * A checksum failure gets the most prominent treatment on this screen, and its
 * own explanation of what a mismatch means. It is the one outcome here that is
 * evidence of something rather than a configuration problem, and rendering it
 * as another red box saying "failed" would waste the only signal this pipeline
 * exists to produce.
 */
function OutcomePanel({ outcome }: { outcome: InstallOutcome }) {
  if (outcome.ok) {
    const r = outcome.result;
    const leftOut = leftOutLine(r.leftOut);
    return (
      <div className="space-y-4">
        <Notice
          tone="success"
          icon={<CheckCircle2 className="h-4 w-4" aria-hidden />}
        >
          <p className="font-medium">
            Checksum verified and{" "}
            {r.pending || r.registry?.ok ? "registry checks passed" : "written to disk"}.
          </p>
          {r.pending ? (
            <p className="mt-1">
              It is waiting in <code className="font-mono text-xs">{r.installPath}/</code>,
              where none of its code has run. Review what it will run, then
              register it: here, from{" "}
              {r.kind === "app" ? "Admin > Apps" : "Admin > Connectors"} later, or
              with <code className="font-mono text-xs">npm run register -- {r.kind}/{r.slug}</code>{" "}
              in this checkout.
            </p>
          ) : (
            <p className="mt-1">{r.nextStep}</p>
          )}
        </Notice>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
          <Row label="Installed to">
            <code className="font-mono text-xs">{r.installPath}</code>
          </Row>
          <Row label="Version">
            {r.version}
            {r.gitTag && ` (${r.gitTag})`}
          </Row>
          <Row label="Commit">
            <code className="break-all font-mono text-xs">{r.commitSha}</code>
          </Row>
          <Row label="Verified">
            <code className="break-all font-mono text-xs">{r.contentHash}</code>
          </Row>
          <Row label="Contents">
            {r.fileCount} files · {Math.round(r.byteCount / 1024)} KB
            {leftOut && <span className="mt-1 block text-muted-foreground">{leftOut}</span>}
          </Row>
        </dl>
        {/* A theme registers as it installs, so it is ready to commit now. */}
        {r.handBack && (
          <section>
            <h3 className="text-sm font-semibold text-foreground">Ship it</h3>
            <div className="mt-2">
              <HandBackPanel handBack={r.handBack} isApp={false} />
            </div>
          </section>
        )}
      </div>
    );
  }

  // Not a failure: someone else was registering, and this one never started.
  // Neutral rather than a warning, because there is nothing to fix; the
  // footer's "Try again" is the whole of what to do.
  if (outcome.code === "locked") {
    return (
      <Notice tone="neutral" icon={<Clock className="h-4 w-4" aria-hidden />}>
        <p className="font-medium">Not installed yet</p>
        <p className="mt-1">{outcome.message}</p>
      </Notice>
    );
  }

  const isChecksum = outcome.code === "checksum";
  return (
    <div className="space-y-4">
      <Notice
        tone={isChecksum ? "danger" : "warning"}
        icon={
          isChecksum ? (
            <ShieldCheck className="h-4 w-4" aria-hidden />
          ) : (
            <AlertTriangle className="h-4 w-4" aria-hidden />
          )
        }
      >
        <p className="font-medium">
          {isChecksum ? "Checksum verification failed" : "Not installed"}
        </p>
        <p className="mt-1">{outcome.message}</p>
      </Notice>
      {outcome.detail && (
        <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-muted p-3 text-xs text-foreground">
          {outcome.detail}
        </pre>
      )}
    </div>
  );
}
