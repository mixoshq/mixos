/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import type { RemovalHandBack } from "@/lib/repository/hand-back";
import { KEPT_DATA } from "@/lib/repository/remove-outcomes";
import type { ExtensionKind } from "@/lib/repository/types";
import { CopyButton } from "../copy-button";

/**
 * What to do once an extension's code is gone from this checkout: commit the
 * deletion, push it, and deploy. Built on the server
 * (removalHandBackFor() in src/lib/repository/hand-back.ts).
 *
 * The server never runs git, so these are commands for a person, with the
 * commit message built from identifiers. It can't see whether git tracked the
 * folder either: one that was never committed leaves nothing to commit, which
 * `npm run remove` checks for itself.
 */
export default function RemovalHandBackPanel({
  handBack,
  kind,
}: {
  handBack: RemovalHandBack;
  kind: ExtensionKind;
}) {
  return (
    <div className="space-y-4 text-sm text-foreground">
      <p>
        It is gone from this checkout only. Commit the deletion of{" "}
        <code className="font-mono text-xs">{handBack.folder}</code> and deploy to remove it from your
        instances.
      </p>

      <div>
        <p className="text-muted-foreground">
          Files deleted from <code className="font-mono text-xs">{`${handBack.folder}/`}</code>{" "}
          {`(${handBack.fileCount} ${handBack.fileCount === 1 ? "file" : "files"}, ${handBack.totalSize})`}
        </p>
        <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-border p-3">
          {handBack.files.map((file) => (
            <li key={file.path} className="flex min-w-0 items-baseline justify-between gap-4">
              <code className="min-w-0 break-all font-mono text-xs">{file.path}</code>
              <span className="shrink-0 text-xs text-muted-foreground">{file.size}</span>
            </li>
          ))}
          {handBack.more > 0 && <li className="text-xs text-muted-foreground">and {handBack.more} more</li>}
        </ul>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2">
          <p>Commit it on a branch of its own, and push. The message records what was removed.</p>
          <CopyButton text={handBack.commands} label="Copy" />
        </div>
        <pre className="mt-2 overflow-x-auto whitespace-pre rounded-lg border border-border bg-muted p-3 font-mono text-xs text-foreground">
          {handBack.commands}
        </pre>
        <p className="mt-2 text-muted-foreground">
          Or run <code className="font-mono text-xs">/mixos deploy</code>, which branches, commits,
          pushes and opens a pull request. If <code className="font-mono text-xs">{handBack.folder}</code>{" "}
          was never committed, there is nothing to commit.
        </p>
      </div>

      <p className="text-muted-foreground">
        Merging it into the branch your host deploys ships it on Coolify, Dokploy, Render, Railway
        and Vercel. With Docker Compose on your own server, pull it there, then build, migrate and
        start.{kind !== "theme" && ` ${KEPT_DATA[kind]}`}
      </p>
    </div>
  );
}
