/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import {
  registerExtensionAction,
  resolveInstallAction,
  type RegisterOutcome,
} from "@/lib/repository/actions";
import type {
  Extension,
  ExtensionSummary,
  InstallManifest,
} from "@/lib/repository/types";
import { KIND_LABEL } from "@/lib/repository/types";

/**
 * The confirmation step, and the only place registration is started from.
 *
 * ── WHY THIS IS A DIALOG AND NOT A ONE-CLICK BUTTON ─────────────────────────
 *
 * Registering copies third-party code into this instance's source tree and
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
  onClose,
  onRegistered,
}: {
  extension: ExtensionSummary | null;
  onClose: () => void;
  /** Told the identifier so the grid can flip the tile to "Installed". */
  onRegistered: (slug: string) => void;
}) {
  const [manifest, setManifest] = useState<InstallManifest | null>(null);
  const [listing, setListing] = useState<Extension | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RegisterOutcome | null>(null);
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
      const res = await registerExtensionAction({
        kind,
        slug,
        version: manifest?.version,
        allowYanked: acceptYanked,
      });
      setOutcome(res);
      if (res.ok) onRegistered(slug);
    } finally {
      setBusy(false);
    }
  }, [kind, slug, manifest?.version, acceptYanked, onRegistered]);

  if (!extension || !kind) return null;

  const yanked = manifest?.yanked === true;
  const blocked = yanked && !acceptYanked;

  return (
    <Dialog
      open
      onClose={onClose}
      title={outcome?.ok ? `${extension.name} registered` : `Register ${extension.name}`}
      subtitle={
        outcome
          ? undefined
          : listing
            ? `${KIND_LABEL[kind].one} · ${listing.sourceRepo.owner}/${listing.sourceRepo.name}`
            : `${KIND_LABEL[kind].one} · ${extension.slug}`
      }
      size="lg"
      footer={
        outcome ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              busy={busy}
              busyLabel="Verifying and registering…"
              disabled={!manifest || blocked}
              onClick={register}
            >
              Verify and register
            </Button>
          </>
        )
      }
    >
      {outcome ? (
        <OutcomePanel outcome={outcome} />
      ) : resolveError ? (
        <div className="space-y-4">
          <Notice tone="danger" icon={<XCircle className="h-4 w-4" aria-hidden />}>
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
          {yanked && (
            <Notice tone="warning" icon={<AlertTriangle className="h-4 w-4" aria-hidden />}>
              <p className="font-medium">
                Version {manifest.version} has been withdrawn by its publisher.
              </p>
              {manifest.yankedReason && <p className="mt-1">{manifest.yankedReason}</p>}
              <Checkbox
                className="mt-3"
                label="Register it anyway."
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
              The code is downloaded from GitHub at the exact commit below, not from
              mixos.org. It is only written to this instance if its checksum matches
              what the repository published.
            </p>
            <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
              <Row label="Version">
                {manifest.version}{" "}
                <span className="text-muted-foreground">({manifest.gitTag})</span>
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
                <code className="break-all font-mono text-xs">{manifest.commitSha}</code>
              </Row>
              <Row label="Checksum">
                <code className="break-all font-mono text-xs">{manifest.contentHash}</code>
              </Row>
              {manifest.subpath && (
                <Row label="Subdirectory">
                  <code className="font-mono text-xs">{manifest.subpath}</code>
                </Row>
              )}
              <Row label="Installs to">
                <code className="font-mono text-xs">
                  {kind === "connector" ? "connectors" : kind === "theme" ? "themes" : "apps"}/
                  {manifest.slug}
                </code>
              </Row>
            </dl>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-foreground">
              What the publisher says it needs
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Declared on the mixos.org listing. What this instance actually enforces
              comes from the manifest inside the package, once the registry checks have
              run on it.
            </p>
            {manifest.permissions.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">
                No permissions declared.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {manifest.permissions.map((p) => (
                  <li key={p.scope} className="text-sm">
                    <code className="font-mono text-xs text-foreground">{p.scope}</code>
                    <span className="ml-2 text-muted-foreground">{p.reason}</span>
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}

function Notice({
  tone,
  icon,
  children,
}: {
  tone: "warning" | "danger" | "success";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const TONES = {
    warning: "border-warning/40 bg-warning/10",
    danger: "border-destructive/40 bg-destructive/10",
    success: "border-success/40 bg-success/10",
  } as const;
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm text-foreground ${TONES[tone]}`}>
      <div className="flex gap-2">
        <span className="mt-0.5 shrink-0">{icon}</span>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
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
function OutcomePanel({ outcome }: { outcome: RegisterOutcome }) {
  if (outcome.ok) {
    const r = outcome.result;
    return (
      <div className="space-y-4">
        <Notice tone="success" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />}>
          <p className="font-medium">
            Checksum verified and {r.registry.ok ? "registry checks passed" : "written to disk"}.
          </p>
          <p className="mt-1">{r.nextStep}</p>
        </Notice>
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
          <Row label="Installed to">
            <code className="font-mono text-xs">{r.installPath}</code>
          </Row>
          <Row label="Version">
            {r.version} ({r.gitTag})
          </Row>
          <Row label="Commit">
            <code className="break-all font-mono text-xs">{r.commitSha}</code>
          </Row>
          <Row label="Verified">
            <code className="break-all font-mono text-xs">{r.contentHash}</code>
          </Row>
          <Row label="Contents">
            {r.fileCount} files · {Math.round(r.byteCount / 1024)} KB
          </Row>
        </dl>
      </div>
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
          {isChecksum ? "Checksum verification failed" : "Not registered"}
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
