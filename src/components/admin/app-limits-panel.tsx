/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import type { AppNarrowing } from "@/lib/connectors/reach";

/** The page's server action for an app's limits on a connector, re-checking the admin. */
export type SetAppLimits = (connectorName: string, appSlug: string, narrowing: AppNarrowing) => Promise<void>;

/**
 * Narrow one app's reach on a connector, from its Reach row
 * (src/lib/connectors/app-access.ts): take its writes away, or tick the only
 * methods it may call. It only ever narrows what the manifest and Allow
 * changes give it; nothing here widens. Inline, beside the row it is about.
 */
export default function AppLimitsPanel({
  connectorName,
  appSlug,
  appName,
  methods,
  asksWrites,
  narrowing,
  setLimits,
}: {
  connectorName: string;
  appSlug: string;
  appName: string;
  /** Every method the app could reach here, before any limit, each with whether it changes data. */
  methods: { method: string; mutates: boolean }[];
  /** Its entry asks for "write" and the connector declares a write, so there is a write to take away. */
  asksWrites: boolean;
  narrowing: AppNarrowing | null;
  setLimits: SetAppLimits;
}) {
  const [denyWrites, setDenyWrites] = useState(narrowing?.writes === "deny");
  const [chosen, setChosen] = useState<Set<string>>(
    new Set(narrowing?.methods ?? methods.map((m) => m.method)),
  );
  const [saving, startSave] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const save = (next: AppNarrowing) =>
    startSave(async () => {
      setError(null);
      try {
        await setLimits(connectorName, appSlug, next);
      } catch (err) {
        setError(err instanceof Error ? err.message : "The limits couldn't be saved.");
      }
    });
  const all = chosen.size === methods.length;

  return (
    <div className="mt-2 space-y-3 rounded-md border border-border bg-background p-3">
      <p className="text-sm text-muted-foreground">
        Narrow what {appName} may call here. This only takes away: what its manifest and Allow changes give it stays
        the most it can have. A call outside these limits is refused, and shows on its tile as unusual activity.
      </p>
      {asksWrites && (
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={denyWrites}
            onChange={(e) => setDenyWrites(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          Can&apos;t change data, even though it asks to
        </label>
      )}
      <fieldset>
        <legend className="text-sm font-medium text-foreground">Methods it may call</legend>
        <ul className="mt-1 space-y-1">
          {methods.map((m) => (
            <li key={m.method}>
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={chosen.has(m.method)}
                  disabled={m.mutates && denyWrites}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(m.method);
                    else next.delete(m.method);
                    setChosen(next);
                  }}
                  className="h-4 w-4 rounded border-input"
                />
                <span className="font-mono">{m.method}</span>
                {m.mutates && <StatusPill tone="warning">Changes data</StatusPill>}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          busy={saving}
          busyLabel="Saving…"
          disabled={chosen.size === 0}
          onClick={() => save({ writes: denyWrites ? "deny" : "inherit", methods: all ? null : [...chosen] })}
        >
          Save its limits
        </Button>
        {narrowing && (
          <Button variant="ghost" size="sm" onClick={() => save({ writes: "inherit", methods: null })}>
            Remove its limits
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
          {error}
        </p>
      )}
    </div>
  );
}
