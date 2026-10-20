/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { ExternalLink } from "lucide-react";
import type { HandBack } from "@/lib/repository/hand-back";
import { CopyButton } from "../copy-button";
import { FileChanges } from "../update/update-parts";

/**
 * What to do once an extension runs in this checkout: commit it, push it, and
 * deploy. Built on the server (src/lib/repository/hand-back.ts), shown after
 * Register and after a theme's install, which registers it.
 *
 * The server never runs git, so these are commands for a person, with the
 * commit message prepared from the install record. `/mixos deploy` does the
 * same steps and opens the pull request.
 *
 * The server can't see the checkout's ignore rules either, so it says to check
 * `git status`: a rule in .gitignore can leave a file out of `git add`, and the
 * commit would then not hold the folder that was verified. `npm run register`
 * checks for that itself.
 *
 * For an update it lists the files the commit changes instead of the files it
 * adds, and ends with how to roll the update back once it is deployed.
 */
export default function HandBackPanel({ handBack, isApp }: { handBack: HandBack; isApp: boolean }) {
  const update = handBack.update;
  return (
    <div className="space-y-4 text-sm text-foreground">
      <p>
        It runs only in this checkout until you commit {update ? "the change to " : ""}
        <code className="font-mono text-xs">{handBack.folder}</code> and deploy it.
      </p>

      {update ? (
        <div>
          <p className="text-muted-foreground">
            What the commit changes in <code className="font-mono text-xs">{`${handBack.folder}/`}</code>
          </p>
          <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-border p-3">
            <FileChanges changes={update.changes} />
          </div>
        </div>
      ) : (
        <div>
          <p className="text-muted-foreground">
            Files added in <code className="font-mono text-xs">{`${handBack.folder}/`}</code>{" "}
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
      )}

      <div>
        <div className="flex items-center justify-between gap-2">
          <p>
            Commit it on a branch of its own, and push. The message records{" "}
            {update ? "both releases and where they came from." : "where it came from."}
          </p>
          <CopyButton text={handBack.commands} label="Copy" />
        </div>
        <pre className="mt-2 overflow-x-auto whitespace-pre rounded-lg border border-border bg-muted p-3 font-mono text-xs text-foreground">
          {handBack.commands}
        </pre>
        <p className="mt-2 text-muted-foreground">
          Or run <code className="font-mono text-xs">/mixos deploy</code>, which branches, commits,
          pushes and opens a pull request. Before you commit, check that{" "}
          <code className="font-mono text-xs">git status</code> lists every file above: a rule in
          your <code className="font-mono text-xs">.gitignore</code> can leave one out.
        </p>
      </div>

      {handBack.sourceUrl && (
        <p>
          <a
            href={handBack.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2"
          >
            The source on GitHub, at the commit that was verified
            <ExternalLink className="ml-1 inline h-3.5 w-3.5 align-[-0.125em]" aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </p>
      )}

      <p className="text-muted-foreground">
        Merging it into the branch your host deploys ships it on Coolify, Dokploy, Render, Railway
        and Vercel. With Docker Compose on your own server, pull it there, then build, migrate and
        start.
        {!update && isApp && " It arrives inactive on each instance: activate it there, in Admin > Apps."}
      </p>
      {update && <p className="text-muted-foreground">{update.rollback}</p>}
    </div>
  );
}
