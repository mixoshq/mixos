/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { CARD_SHELL } from "@/components/ui/card";
import { StatusPill } from "@/components/ui/status";
import type { PendingKind } from "@/lib/repository/pending";
import { cn } from "@/lib/utils";
import DiscardDialog from "./discard-dialog";
import ReviewDialog, { type PendingTarget } from "./review-dialog";
import WithCode from "./with-code";

/** One pending install, as the server read it for this list. */
export interface PendingItem {
  kind: PendingKind;
  slug: string;
  /** The manifest's name, or the slug. */
  name: string;
  /** Repo-relative: `.mixos/pending/apps/<slug>`. */
  path: string;
  version: string | null;
  /** "Installed 3 mins ago by admin@example.com", or null when its record can't be read. */
  installed: string | null;
  /** For an update of an extension in place: the version it would replace, which stays. */
  updateFrom: string | null;
  /** What stands in the way of registering it, or null. */
  problem: string | null;
  canRegister: boolean;
  /** False only for a registration that stopped midway, which recovery deals with. */
  canDiscard: boolean;
}

/**
 * Installs from the Registry waiting in `.mixos/pending/`, with Register,
 * which reviews first, and Discard.
 *
 * The dialogs live here rather than in each card, and this renders even with
 * nothing pending: registering or discarding the last one re-renders the page
 * without it, and the result has to stay on screen.
 */
export default function PendingInstallsList({
  kind,
  items,
}: {
  kind: PendingKind;
  items: PendingItem[];
}) {
  const [reviewing, setReviewing] = useState<PendingTarget | null>(null);
  const [discarding, setDiscarding] = useState<(PendingTarget & { path: string; updateFrom: string | null }) | null>(
    null,
  );
  const many = kind === "app" ? "apps" : "connectors";

  return (
    <>
      {items.length > 0 && (
        <section aria-labelledby={`pending-${many}`} className="mb-8">
          <h2 id={`pending-${many}`} className="text-lg font-medium text-foreground">
            Waiting to register
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Installed from the Registry into <code className="font-mono text-xs">.mixos/pending/</code>,
            where none of their code runs. Review what each one will run, then
            register it to add it to this checkout, or discard it.
          </p>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => (
              <li key={item.slug} className={cn(CARD_SHELL, "flex flex-col p-5")}>
                <h3 className="truncate text-lg font-medium text-foreground" title={item.name}>
                  {item.name}
                </h3>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <StatusPill tone={item.problem ? "warning" : "neutral"}>
                    {item.problem ? "Needs attention" : "Not registered"}
                  </StatusPill>
                  {item.version && <StatusPill tone="neutral">{item.version}</StatusPill>}
                </div>
                {item.installed && (
                  <p className="mt-3 text-xs text-muted-foreground">{item.installed}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  <code className="break-all font-mono">{item.path}/</code>
                </p>
                {item.problem && (
                  <p className="mt-3 text-sm text-foreground">
                    <WithCode text={item.problem} />
                  </p>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
                  {item.canRegister && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setReviewing({ kind: item.kind, slug: item.slug, name: item.name })}
                    >
                      Review and register
                    </Button>
                  )}
                  {item.canDiscard && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setDiscarding({
                          kind: item.kind,
                          slug: item.slug,
                          name: item.name,
                          path: item.path,
                          updateFrom: item.updateFrom,
                        })
                      }
                    >
                      Discard
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ReviewDialog
        key={reviewing ? `review:${reviewing.kind}/${reviewing.slug}` : "review:none"}
        target={reviewing}
        onClose={() => setReviewing(null)}
      />
      <DiscardDialog
        key={discarding ? `discard:${discarding.kind}/${discarding.slug}` : "discard:none"}
        target={discarding}
        onClose={() => setDiscarding(null)}
      />
    </>
  );
}
