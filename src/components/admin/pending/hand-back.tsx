/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HandBack } from "@/lib/repository/hand-back";

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
 */
export default function HandBackPanel({ handBack, isApp }: { handBack: HandBack; isApp: boolean }) {
  return (
    <div className="space-y-4 text-sm text-foreground">
      <p>
        It runs only in this checkout until you commit{" "}
        <code className="font-mono text-xs">{handBack.folder}</code> and deploy it.
      </p>

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

      <div>
        <div className="flex items-center justify-between gap-2">
          <p>Commit it on a branch of its own, and push. The message records where it came from.</p>
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
        {isApp && " It arrives inactive on each instance: activate it there, in Admin > Apps."}
      </p>
    </div>
  );
}

/**
 * Copies `text`, and says so for two seconds. Selecting the text by hand still
 * works when it can't. The removal result uses it too.
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={copied ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard access can be refused (permissions, an insecure origin).
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}
