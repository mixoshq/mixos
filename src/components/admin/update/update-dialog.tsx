/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Loader2 } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Checkbox, Select } from "@/components/ui/input";
import Notice from "@/components/ui/notice";
import type { PendingKind } from "@/lib/repository/pending";
import type { DeclarationChange, LocalChanges, UpdateDirection } from "@/lib/repository/update";
import {
  compareUpdateAction,
  updateExtensionAction,
  updateOverviewAction,
} from "@/lib/repository/update-actions";
import type {
  ComparisonOutcome,
  OverviewOutcome,
  PickableRelease,
  PreparedUpdate,
  ReleaseView,
  UpdateComparison,
  UpdateOutcome,
  UpdateOverview,
} from "@/lib/repository/update-outcomes";
import { KIND_LABEL } from "@/lib/repository/types";
import FloorNotice from "../browse/floor-notice";
import WithCode from "../pending/with-code";

/** An extension to update, as whatever opens the dialog names it. */
export interface UpdateTarget {
  kind: PendingKind;
  slug: string;
  /** For the title. The overview reads the manifest's own. */
  name: string;
}

/**
 * Update an app or a connector installed from a Registry to another release.
 * Mounted while it is open, so each one starts fresh.
 *
 * It says first what is installed and whether the folder still matches it,
 * naming the files that changed when they can be named. The admin picks a
 * release, newest first, with its date and which way it is from the installed
 * one; the dialog downloads and verifies that release to compare it: the
 * publisher's claims, what the package's manifest declares, its migrations,
 * whether it was withdrawn, and its MixOS floor. Local changes, an older
 * release and a withdrawn one each need the admin's explicit say before the
 * button does anything.
 *
 * The update downloads, verifies and checks the release again, under the
 * locks, and leaves it in `.mixos/pending/`. The folder in place is replaced
 * only when that is registered.
 */
export default function UpdateDialog({ target, onClose }: { target: UpdateTarget; onClose: () => void }) {
  const router = useRouter();
  const [overview, setOverview] = useState<OverviewOutcome | null>(null);
  const [version, setVersion] = useState("");
  const [comparison, setComparison] = useState<ComparisonOutcome | null>(null);
  const [discard, setDiscard] = useState(false);
  const [older, setOlder] = useState(false);
  const [withdrawn, setWithdrawn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<UpdateOutcome | null>(null);
  const asked = useRef("");
  const lockedNotice = useRef<HTMLDivElement>(null);

  const { kind, slug } = target;
  const locked = outcome?.ok === false && outcome.code === "locked";

  useEffect(() => {
    if (locked) lockedNotice.current?.scrollIntoView({ block: "nearest" });
  }, [locked, outcome]);

  /** Compare with `v`, keeping only the answer for the release picked last. */
  const compare = useCallback(
    async (v: string) => {
      asked.current = v;
      const res = await compareUpdateAction({ kind, slug, version: v });
      if (asked.current === v) setComparison(res);
    },
    [kind, slug],
  );

  useEffect(() => {
    let live = true;
    void updateOverviewAction({ kind, slug }).then((res) => {
      if (!live) return;
      setOverview(res);
      if (res.ok && res.overview.suggested) {
        setVersion(res.overview.suggested);
        void compare(res.overview.suggested);
      }
    });
    return () => {
      live = false;
    };
  }, [kind, slug, compare]);

  const pick = (v: string) => {
    setVersion(v);
    setComparison(null);
    setOutcome(null);
    // What was said yes to was about the release picked before.
    setOlder(false);
    setWithdrawn(false);
    if (v) void compare(v);
  };

  const update = useCallback(async () => {
    if (comparison?.ok !== true) return;
    const c = comparison.comparison;
    setBusy(true);
    try {
      setOutcome(
        await updateExtensionAction({
          kind,
          slug,
          version: c.to.version,
          allowYanked: c.needs.allowYanked ? withdrawn : undefined,
          allowOlder: c.needs.allowOlder ? older : undefined,
          discardLocalChanges: c.needs.discardLocalChanges ? discard : undefined,
          reviewed: c.reviewed,
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [comparison, kind, slug, withdrawn, older, discard]);

  const close = useCallback(() => {
    // The pending list on the page behind gains the update.
    if (outcome?.ok) router.refresh();
    onClose();
  }, [outcome, onClose, router]);

  const done = outcome?.ok === true;
  const refused = outcome?.ok === false && !locked;
  const c = comparison?.ok ? comparison.comparison : null;
  const ready =
    c !== null &&
    c.blocker === null &&
    c.floor.met &&
    (!c.needs.discardLocalChanges || discard) &&
    (!c.needs.allowOlder || older) &&
    (!c.needs.allowYanked || withdrawn);
  const nothingToPick = overview !== null && (!overview.ok || overview.overview.releases.length === 0);

  return (
    <Dialog
      open
      onClose={busy ? () => {} : close}
      title={done ? `${target.name}: update downloaded` : `Update ${target.name}`}
      subtitle={`${KIND_LABEL[kind].one} · ${slug}`}
      size="lg"
      footer={
        done || refused || nothingToPick ? (
          <Button variant="primary" onClick={close}>
            {done ? "Done" : "Close"}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" busy={busy} busyLabel="Downloading and checking…" disabled={!ready} onClick={update}>
              {locked ? "Try again" : "Download update"}
            </Button>
          </>
        )
      }
    >
      {outcome?.ok ? (
        <PreparedView result={outcome.result} />
      ) : refused && outcome && !outcome.ok ? (
        <div className="space-y-4">
          <Notice tone={outcome.tone} title="Not updated">
            <WithCode text={outcome.message} />
          </Notice>
          {outcome.detail && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted p-3 text-xs text-foreground">
              {outcome.detail}
            </pre>
          )}
        </div>
      ) : overview === null ? (
        <Loading>Reading what is installed…</Loading>
      ) : !overview.ok ? (
        <Notice tone={overview.tone}>
          <WithCode text={overview.message} />
        </Notice>
      ) : (
        <div className="space-y-6">
          <ReleasePicker overview={overview.overview} version={version} onPick={pick} />
          {version &&
            (comparison === null ? (
              <Loading>Downloading {version} and checking it against its checksum, to compare…</Loading>
            ) : !comparison.ok ? (
              <div className="space-y-3">
                <Notice tone={comparison.tone} title={`${version} can't be compared`}>
                  <WithCode text={comparison.message} />
                </Notice>
                {comparison.detail && (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted p-3 text-xs text-foreground">
                    {comparison.detail}
                  </pre>
                )}
              </div>
            ) : (
              <ComparisonView
                comparison={comparison.comparison}
                older={older}
                onOlder={setOlder}
                withdrawn={withdrawn}
                onWithdrawn={setWithdrawn}
              />
            ))}
          <LocalChangesView
            local={overview.overview.local}
            path={overview.overview.path}
            version={overview.overview.installed.version}
            discard={discard}
            onDiscard={setDiscard}
          />
          {c && c.blocker === null && (
            <Section title="Then">
              <p className="text-sm text-foreground">
                Downloading checks {c.to.version} again, as an install does, and leaves it in{" "}
                <Path>{`.mixos/pending/${c.kind === "app" ? "apps" : "connectors"}/${c.slug}/`}</Path>, where
                none of its code runs. <Path>{`${c.path}/`}</Path> stays as it is until the update is registered.
              </p>
            </Section>
          )}
          {/* Beside the button that was pressed, where the admin is looking. */}
          {locked && outcome && !outcome.ok && (
            <div ref={lockedNotice}>
              <Notice tone="neutral" title="Not updated yet">
                <WithCode text={outcome.message} />
              </Notice>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/*  The installed release and the picker                                        */
/* -------------------------------------------------------------------------- */

const DIRECTION_WORD: Record<UpdateDirection, string> = {
  newer: "newer",
  older: "older",
  same: "installed",
  unknown: "order unknown",
};

/** A release's tag, when it says more than its version: not `v1.3.0` beside `1.3.0`. */
function tagBeside(version: string, tag: string | null): string | null {
  return tag && tag !== version && tag !== `v${version}` ? tag : null;
}

/** One option's words, short enough for a phone: `1.3.0 · 8 Oct 2026 · newer · current`. */
function optionLabel(r: PickableRelease): string {
  const tag = tagBeside(r.version, r.gitTag);
  return [
    `${r.version}${tag ? ` (${tag})` : ""}`,
    r.releasedAt ? formatDay(r.releasedAt) : "date unknown",
    DIRECTION_WORD[r.direction],
    ...(r.current ? ["current"] : []),
    ...(r.yanked ? ["withdrawn"] : []),
  ].join(" · ");
}

export function ReleasePicker({
  overview,
  version,
  onPick,
}: {
  overview: UpdateOverview;
  version: string;
  onPick: (version: string) => void;
}) {
  const { installed, releases } = overview;
  const runsCurrent = releases.some((r) => r.current && r.direction === "same");
  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground">
        <Path>{`${overview.path}/`}</Path> runs {installed.version}
        {installed.releasedAt ? `, published ${formatDay(installed.releasedAt)}` : ""}, installed from{" "}
        {overview.host}
        {runsCurrent ? ", which is the current release." : "."}
      </p>
      {installed.yanked && (
        <Notice tone="warning" title={`${installed.version} was withdrawn by its publisher`}>
          {installed.yankedReason ?? "Its publisher gave no reason."}
        </Notice>
      )}
      {overview.listingProblem ? (
        <Notice tone="warning">
          <WithCode text={overview.listingProblem} />
        </Notice>
      ) : releases.length === 0 ? (
        <Notice tone="neutral">{overview.host} lists no release of it to update to.</Notice>
      ) : (
        <Field
          label="Update to"
          hint="Any release its publisher listed, newest first. An older one has to be chosen as such."
        >
          {(props) => (
            <Select
              {...props}
              value={version}
              placeholder="Choose a release"
              options={releases.map((r) => ({ value: r.version, label: optionLabel(r) }))}
              onChange={(e) => onPick(e.target.value)}
            />
          )}
        </Field>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The comparison                                                              */
/* -------------------------------------------------------------------------- */

export function ComparisonView({
  comparison: c,
  older,
  onOlder,
  withdrawn,
  onWithdrawn,
}: {
  comparison: UpdateComparison;
  older: boolean;
  onOlder: (yes: boolean) => void;
  withdrawn: boolean;
  onWithdrawn: (yes: boolean) => void;
}) {
  return (
    <div className="space-y-6">
      {c.blocker && (
        <Notice tone="neutral">
          <WithCode text={c.blocker} />
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <ReleaseCard title="Installed" release={c.from} />
        <ReleaseCard title="Update to" release={c.to} withdrawn={c.to.yanked} />
      </div>
      {c.compareUrl && (
        <p className="text-sm">
          <a href={c.compareUrl} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
            Compare {c.from.version} and {c.to.version} on GitHub
            <ExternalLink className="ml-1 inline h-3.5 w-3.5 align-[-0.125em]" aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}
      {c.otherRepository && (
        <Notice tone="warning" title="It comes from another repository">
          {c.to.version} is published from {c.otherRepository.to}, and {c.from.version} came from{" "}
          {c.otherRepository.from}. Once this is deployed, each instance treats it as a different extension:
          it is switched off until an admin types its slug to turn it on.
        </Notice>
      )}

      {c.needs.allowOlder && (
        <Notice
          tone="warning"
          title={
            c.direction === "older"
              ? `${c.to.version} is older than ${c.from.version}`
              : `Which of ${c.from.version} and ${c.to.version} is newer can't be told`
          }
        >
          <p>
            {c.direction === "older"
              ? "Installing it goes back to an earlier release."
              : `Their versions aren't both dotted, and ${c.host} doesn't give a date for both, so it may be an older release.`}
          </p>
          <Checkbox className="mt-3" label="Install an older release." checked={older} onChange={(e) => onOlder(e.target.checked)} />
        </Notice>
      )}

      {c.to.yanked && (
        <Notice tone="warning" title={`${c.to.version} was withdrawn by its publisher`}>
          {c.to.yankedReason && <p>{c.to.yankedReason}</p>}
          <Checkbox
            className="mt-3"
            label="Install it anyway."
            checked={withdrawn}
            onChange={(e) => onWithdrawn(e.target.checked)}
          />
        </Notice>
      )}

      <FloorNotice floor={c.floor} installable />

      <Section title="What the publisher says it needs">
        <p className="text-xs text-muted-foreground">Their words on {c.host}, not a guarantee.</p>
        <Claims claims={c.claims} />
      </Section>

      <Section title="What the package declares">
        <p className="text-xs text-muted-foreground">
          From the manifest in <Path>{`${c.path}/`}</Path> to the one in {c.to.version}: what this instance enforces.
        </p>
        <Declarations declarations={c.declarations} kind={c.kind} />
      </Section>

      {c.kind === "app" && (
        <Section title="Migrations">
          <Migrations comparison={c} />
        </Section>
      )}
    </div>
  );
}

function ReleaseCard({ title, release, withdrawn = false }: { title: string; release: ReleaseView; withdrawn?: boolean }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{title}</h4>
      <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Version</dt>
        <dd className="min-w-0 break-words text-foreground">
          {release.version}
          {release.gitTag && release.gitTag !== release.version && (
            <span className="text-muted-foreground"> ({release.gitTag})</span>
          )}
          {withdrawn && <span className="text-muted-foreground"> · withdrawn</span>}
        </dd>
        <dt className="text-muted-foreground">Commit</dt>
        <dd className="min-w-0">
          {release.sourceUrl ? (
            <a
              href={release.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              title={release.commitSha}
              className="font-mono text-xs underline underline-offset-2"
            >
              {release.commitSha.slice(0, 12)}
              <ExternalLink className="ml-1 inline h-3 w-3 align-[-0.125em]" aria-hidden />
              <span className="sr-only"> (the source on GitHub, opens in a new tab)</span>
            </a>
          ) : (
            <code className="font-mono text-xs" title={release.commitSha}>
              {release.commitSha.slice(0, 12)}
            </code>
          )}
        </dd>
        <dt className="text-muted-foreground">Published</dt>
        <dd className="text-foreground">{release.releasedAt ? formatDay(release.releasedAt) : "Not known"}</dd>
      </dl>
    </div>
  );
}

function Claims({ claims }: { claims: UpdateComparison["claims"] }) {
  if (claims.state === "unavailable") {
    return <p className="mt-2 text-sm text-muted-foreground">{claims.message}</p>;
  }
  const { added, removed, changed } = claims;
  if (added.length + removed.length + changed.length === 0) {
    return <p className="mt-2 text-sm text-muted-foreground">No change.</p>;
  }
  const list = (items: { scope: string; reason: string }[]) => (
    <ul className="mt-1 space-y-1.5">
      {items.map((claim) => (
        <li key={claim.scope}>
          <code className="break-all font-mono text-xs text-foreground">{claim.scope}</code>
          <span className="block text-muted-foreground">{claim.reason}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="mt-2 space-y-3 text-sm">
      {added.length > 0 && (
        <div>
          <p className="font-medium text-foreground">Now claims</p>
          {list(added)}
        </div>
      )}
      {changed.length > 0 && (
        <div>
          <p className="font-medium text-foreground">Gives another reason for</p>
          {list(changed)}
        </div>
      )}
      {removed.length > 0 && (
        <div>
          <p className="font-medium text-foreground">No longer claims</p>
          {list(removed)}
        </div>
      )}
    </div>
  );
}

/** What carries over for each row whose values an admin saves. */
const SAVED: Record<string, string> = {
  Env:
    "Saved settings carry over. A new one is empty until an admin fills it in on Admin > Apps, and one it " +
    "no longer declares stays saved but isn't read.",
  "Credentials an admin enters":
    "Saved credentials carry over. A new field is empty until an admin fills it in on Admin > Connectors.",
};

function Declarations({ declarations, kind }: { declarations: DeclarationChange[] | null; kind: PendingKind }) {
  if (declarations === null) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        One of the two manifests can&apos;t be read, so they can&apos;t be compared.
      </p>
    );
  }
  if (declarations.length === 0) {
    return (
      <p className="mt-2 text-sm text-muted-foreground">
        No change to its {kind === "app" ? "egress, env, database, connectors, services, hooks or MCP tools" : "hosts, credentials, accounts or webhooks"}.
      </p>
    );
  }
  return (
    <dl className="mt-2 space-y-3 text-sm">
      {declarations.map((row) => (
        <div key={row.label}>
          <dt className="font-medium text-foreground">{row.label}</dt>
          <dd className="mt-0.5 space-y-0.5">
            {row.added.length > 0 && (
              <p className="break-words text-foreground">
                <span className="text-muted-foreground">Adds </span>
                {row.added.join(", ")}
              </p>
            )}
            {row.removed.length > 0 && (
              <p className="break-words text-foreground">
                <span className="text-muted-foreground">Drops </span>
                {row.removed.join(", ")}
              </p>
            )}
            {SAVED[row.label] && <p className="text-xs text-muted-foreground">{SAVED[row.label]}</p>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Migrations({ comparison: c }: { comparison: UpdateComparison }) {
  const { added, changed, lacking } = c.migrations;
  if (added.length + changed.length + lacking.length === 0) {
    return <p className="text-sm text-muted-foreground">No change to its migrations.</p>;
  }
  return (
    <div className="space-y-3">
      {added.length > 0 && (
        <Notice tone="warning" title={`New in ${c.to.version}`}>
          <Files names={added} folder="migrations/" />
          <p className="mt-2">
            The release step applies them, and they are forward-only: back up the database first.
          </p>
        </Notice>
      )}
      {lacking.length > 0 && (
        <Notice tone="warning" title={`In ${c.path}/ and not in ${c.to.version}`}>
          <Files names={lacking} folder="migrations/" />
          <p className="mt-2">
            A database that ran them stays at the newer schema: going back doesn&apos;t undo them. The older code
            has to cope with it, and restoring a backup of the database may be the better way back.
          </p>
        </Notice>
      )}
      {changed.length > 0 && (
        <div className="text-sm">
          <p className="font-medium text-foreground">Changed in {c.to.version}</p>
          <Files names={changed} folder="migrations/" />
          <p className="mt-1 text-muted-foreground">
            Each runs once, so a database that already ran one keeps what it did.
          </p>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Local changes                                                               */
/* -------------------------------------------------------------------------- */

const IGNORED_WORDS = {
  lastUpdated: "its manifest's lastUpdated, which the pre-commit stamp writes",
  "git-files": "git control files (.gitignore, .gitattributes), which install doesn't write",
} as const;

export function LocalChangesView({
  local,
  path,
  version,
  discard,
  onDiscard,
}: {
  local: LocalChanges;
  path: string;
  version: string;
  discard: boolean;
  onDiscard: (yes: boolean) => void;
}) {
  if (local.state === "none") return null;
  return (
    <Section title="Your changes">
      <div className="space-y-3 text-sm text-foreground">
        <p>
          <Path>{`${path}/`}</Path> has changed since {version} was installed. Updating replaces its files, so the
          changes are lost unless they are committed somewhere else first.
        </p>
        {local.state === "unlisted" ? (
          <p className="text-muted-foreground">
            <WithCode text={local.reason} />
          </p>
        ) : (
          <>
            {local.changed.length + local.added.length + local.removed.length === 0 ? (
              <p className="text-muted-foreground">No file that runs differs.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <FileGroup title="Changed" names={local.changed} more={local.more.changed} />
                <FileGroup title="Added" names={local.added} more={local.more.added} />
                <FileGroup title="Deleted" names={local.removed} more={local.more.removed} />
              </div>
            )}
            {local.ignored.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Not listed, since it doesn&apos;t change what runs: {local.ignored.map((i) => IGNORED_WORDS[i]).join("; ")}.
              </p>
            )}
            {local.incomplete && (
              <p className="text-xs text-muted-foreground">The folder holds too many files to list them all.</p>
            )}
          </>
        )}
        <Checkbox
          label={`Discard my changes to ${path}/.`}
          checked={discard}
          onChange={(e) => onDiscard(e.target.checked)}
        />
      </div>
    </Section>
  );
}

function FileGroup({ title, names, more }: { title: string; names: string[]; more: number }) {
  if (names.length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="font-medium text-foreground">{title}</p>
      <Files names={names} />
      {more > 0 && <p className="text-xs text-muted-foreground">and {more} more</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  The result                                                                  */
/* -------------------------------------------------------------------------- */

export function PreparedView({ result }: { result: PreparedUpdate }) {
  return (
    <div className="space-y-5">
      <Notice tone="success" title={`${result.to.version} downloaded and checked`}>
        <p>
          It waits in <Path>{`${result.pendingPath}/`}</Path>, where none of its code runs, and{" "}
          <Path>{`${result.path}/`}</Path> is as it was.
        </p>
      </Notice>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">From</dt>
        <dd className="text-foreground">{result.from.version}</dd>
        <dt className="text-muted-foreground">To</dt>
        <dd className="min-w-0 text-foreground">
          {result.to.version}
          {result.direction === "older" && <span className="text-muted-foreground"> · an older release</span>}
          <span className="block break-all font-mono text-xs text-muted-foreground">{result.to.commitSha}</span>
        </dd>
        {result.localChangesDiscarded && (
          <>
            <dt className="text-muted-foreground">Your changes</dt>
            <dd className="text-foreground">To be discarded when it is registered</dd>
          </>
        )}
      </dl>
      <Section title="Next">
        <p className="text-sm text-foreground">
          <WithCode text={result.nextStep} />
        </p>
      </Section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Pieces                                                                      */
/* -------------------------------------------------------------------------- */

/** "10 Oct 2026", in the reader's own calendar. */
function formatDay(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function Files({ names, folder = "" }: { names: string[]; folder?: string }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {names.map((name) => (
        <li key={name}>
          <code className="break-all font-mono text-xs text-foreground">{`${folder}${name}`}</code>
        </li>
      ))}
    </ul>
  );
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Path({ children }: { children: ReactNode }) {
  return <code className="break-all font-mono text-xs">{children}</code>;
}
