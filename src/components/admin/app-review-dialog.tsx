/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import type { AppManifest } from "@/lib/apps/types";
import type { AppTrust } from "@/lib/apps/app-review";
import { recordAppReviewAction } from "@/lib/apps/admin-actions";
import { describeCapability, type Capability } from "@/lib/apps/capabilities";

/**
 * Review a Registry app before it runs: where it came from, the exact code
 * this instance holds, and everything its manifest lets it do. Recording the
 * review is what lets an admin activate it (src/lib/apps/app-review.ts); it
 * counts for this code only, so any change to its files needs another.
 *
 * The declarations are the whole of what the platform hands the app
 * (docs/security-architecture.md §3.1, §16.1, §24). A review is a person
 * accepting them for this source, not a check that the code is safe.
 */

/** Each thing the app may do, as one line a reviewer can weigh. */
export function declarationLines(app: AppManifest): string[] {
  const lines: string[] = [];
  if (app.global) lines.push("Everyone on this instance gets it, without a grant.");
  for (const c of app.connectorRequirements) {
    lines.push(
      `Calls the ${c.name} connector${c.access === "write" ? ", and asks to change data in it" : ", reading only"}${
        c.optional ? " (optional)" : ""
      }.`,
    );
  }
  if (app.egress.length > 0) lines.push(`Reaches these hosts itself: ${app.egress.join(", ")}.`);
  if (app.database) lines.push("Has tables of its own, in its own schema, reached as its own database role.");
  if (app.env.length > 0) {
    lines.push(`Reads ${app.env.length === 1 ? "a setting" : `${app.env.length} settings`} an admin fills in: ${app.env.map((e) => e.key).join(", ")}.`);
  }
  if (app.notifications) lines.push("Sends push notifications to people who have it.");
  if (app.schedules.length > 0) lines.push(`Runs ${app.schedules.length === 1 ? "a scheduled job" : `${app.schedules.length} scheduled jobs`}, with no user.`);
  if (app.mcp.length > 0) lines.push(`Answers ${app.mcp.length === 1 ? "an MCP tool" : `${app.mcp.length} MCP tools`}, read-only.`);
  if (app.search.length > 0) lines.push("Answers global search, read-only.");
  if (app.provides.length > 0) lines.push(`Offers ${app.provides.length === 1 ? "a service" : `${app.provides.length} services`} to other apps.`);
  if (app.consumes.length > 0) lines.push(`Asks other apps' services: ${app.consumes.map((c) => `${c.app} (${c.service})`).join(", ")}.`);
  for (const e of app.escapes) lines.push(`Declares the escape ${e.rule}: ${e.reason}`);
  if (lines.length === 0) lines.push("Declares nothing beyond its own pages and widgets.");
  return lines;
}

export default function AppReviewDialog({
  app,
  trust,
  added = [],
  open,
  onClose,
}: {
  app: AppManifest;
  trust: AppTrust;
  /** What it asks for beyond what was approved before (Item 8): shown first. */
  added?: Capability[];
  open: boolean;
  onClose: () => void;
}) {
  const [recording, startRecording] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`Review ${app.name}`}
      subtitle="Someone else's code. Read what it can do here before it runs."
      footer={
        <span className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Not now
          </Button>
          <Button
            variant="primary"
            size="sm"
            busy={recording}
            busyLabel="Recording…"
            onClick={() =>
              startRecording(async () => {
                setError(null);
                try {
                  await recordAppReviewAction(app.slug);
                  onClose();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "The review couldn't be recorded.");
                }
              })
            }
          >
            Record my review
          </Button>
        </span>
      }
    >
      <div className="space-y-5">
        {added.length > 0 && (
          <section className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-foreground">New since it was approved</h3>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-foreground">
              {added.map((c) => (
                <li key={`${c.kind}:${c.capability}`}>{describeCapability(c)}</li>
              ))}
            </ul>
          </section>
        )}
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Where it came from</h3>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-foreground">
            {trust.provenance}
            <StatusPill tone="neutral">Third-party</StatusPill>
            {trust.modified && <StatusPill tone="warning">Modified locally</StatusPill>}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Commit <code className="font-mono text-xs">{trust.commitSha.slice(0, 12)}</code>
            {trust.sourceUrl && (
              <>
                {" · "}
                <a
                  href={trust.sourceUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2 hover:no-underline"
                >
                  Its source at this commit
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </>
            )}
          </p>
          {trust.modified && (
            <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
              Its files have changed since it was installed, so what runs here isn&apos;t the release as published.
              The source link shows the release; review the changes in this instance&apos;s repository too.
            </p>
          )}
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">What it can do here</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-foreground">
            {declarationLines(app).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-muted-foreground">
            That is the whole of what MixOS hands it: its own tables, the connector methods it may call, the hosts it
            listed. Its code runs inside this server, so code written to get around the build&apos;s checks could reach
            further (docs/threat-model.md).
          </p>
          {app.database && (
            <p className="mt-2 text-sm text-muted-foreground">
              Its database migrations have already run, as its own role, in its own schema: the release step applies
              them whether or not it has been reviewed.
            </p>
          )}
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">What you are recording</h3>
          <p className="mt-1 text-sm text-foreground">
            That you read the above for this exact code
            {trust.codeHash && (
              <>
                {" "}
                (<code className="font-mono text-xs">{trust.codeHash.slice(7, 19)}</code>)
              </>
            )}
            , and accept it. An admin can then activate it. Any change to its files, an update or a local edit, needs
            another review, and the release step switches it off until it has one.
          </p>
          {trust.previouslyReviewed && (
            <p className="mt-2 text-sm text-muted-foreground">An earlier version of it was reviewed here.</p>
          )}
        </section>

        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
