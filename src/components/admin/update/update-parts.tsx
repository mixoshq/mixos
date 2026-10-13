/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Notice from "@/components/ui/notice";
import type { DeclarationChange, FolderDifferences, MigrationChanges } from "@/lib/repository/update";

/**
 * What an update changes, as the update dialog (./update-dialog.tsx) and the
 * review before Register (../pending/review-panel.tsx) both show it: what the
 * manifest declares, an app's migrations, and the files. Rendering only.
 */

/** What carries over for each row whose values an admin saves. */
const SAVED: Record<string, string> = {
  Env:
    "Saved settings carry over. A new one is empty until an admin fills it in on Admin > Apps, and one it " +
    "no longer declares stays saved but isn't read.",
  "Credentials an admin enters":
    "Saved credentials carry over. A new field is empty until an admin fills it in on Admin > Connectors.",
};

/** The rows of a manifest's declarations that change, with what each adds and drops. */
export function DeclarationChanges({
  declarations,
  kind,
}: {
  declarations: DeclarationChange[] | null;
  kind: "app" | "connector";
}) {
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

/** An app's migrations, from the folder `path` to the release `to`: new ones, ones it lacks, changed ones. */
export function MigrationNotes({ migrations, to, path }: { migrations: MigrationChanges; to: string; path: string }) {
  const { added, changed, lacking } = migrations;
  if (added.length + changed.length + lacking.length === 0) {
    return <p className="text-sm text-muted-foreground">No change to its migrations.</p>;
  }
  return (
    <div className="space-y-3">
      {added.length > 0 && (
        <Notice tone="warning" title={`New in ${to}`}>
          <Files names={added} folder="migrations/" />
          <p className="mt-2">
            The release step applies them, and they are forward-only: back up the database first.
          </p>
        </Notice>
      )}
      {lacking.length > 0 && (
        <Notice tone="warning" title={`In ${path}/ and not in ${to}`}>
          <Files names={lacking} folder="migrations/" />
          <p className="mt-2">
            A database that ran them stays at the newer schema: going back doesn&apos;t undo them. The older code
            has to cope with it, and restoring a backup of the database may be the better way back.
          </p>
        </Notice>
      )}
      {changed.length > 0 && (
        <div className="text-sm">
          <p className="font-medium text-foreground">Changed in {to}</p>
          <Files names={changed} folder="migrations/" />
          <p className="mt-1 text-muted-foreground">
            Each runs once, so a database that already ran one keeps what it did.
          </p>
        </div>
      )}
    </div>
  );
}

/** The files that differ from one folder to another, in three columns on a wide screen. */
export function FileChanges({ changes }: { changes: FolderDifferences }) {
  const none = changes.changed.length + changes.added.length + changes.removed.length === 0;
  return (
    <div className="space-y-2 text-sm">
      {none ? (
        <p className="text-muted-foreground">No file differs.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-3">
          <FileGroup title="Changed" names={changes.changed} more={changes.more.changed} />
          <FileGroup title="Added" names={changes.added} more={changes.more.added} />
          <FileGroup title="Deleted" names={changes.removed} more={changes.more.removed} />
        </div>
      )}
      {changes.incomplete && (
        <p className="text-xs text-muted-foreground">The folder holds too many files to list them all.</p>
      )}
    </div>
  );
}

/** A titled list of paths, with how many more there are. Nothing when it is empty. */
export function FileGroup({ title, names, more }: { title: string; names: string[]; more: number }) {
  if (names.length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="font-medium text-foreground">{title}</p>
      <Files names={names} />
      {more > 0 && <p className="text-xs text-muted-foreground">and {more} more</p>}
    </div>
  );
}

/** Paths, one to a line, each under `folder`. */
export function Files({ names, folder = "" }: { names: string[]; folder?: string }) {
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
