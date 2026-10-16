/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Copy, KeyRound } from "lucide-react";
import type { AppManifest } from "@/lib/apps/types";
import { keyScopes } from "@/lib/apps/access-surfaces";
import {
  listAppApiKeys,
  mintAppApiKey,
  revokeAppApiKey,
  type AppApiKey,
  type MintedAppKey,
} from "@/lib/apps/api-key-actions";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/app-states";
import { StatusPill } from "@/components/ui/status";
import { useToast } from "@/components/ui/toast";

const EVERY_ROUTE = "*";

const EXPIRY_OPTIONS = [
  { label: "Never", value: "" },
  { label: "In 30 days", value: "30" },
  { label: "In 90 days", value: "90" },
  { label: "In a year", value: "365" },
];

/** A key that would be accepted right now: not revoked, not past its expiry. */
export function isLiveKey(k: AppApiKey): boolean {
  if (k.revokedAt) return false;
  return !(k.expiresAt && Date.parse(k.expiresAt) < Date.now());
}

function date(iso: string | null, none: string): string {
  return iso ? new Date(iso).toLocaleDateString() : none;
}

/*
  A refusal comes back from the server actions as a value, with words meant for
  this screen. Anything thrown arrives without its words in production, so a
  failure that wasn't a refusal gets a fixed sentence instead.
*/
const RELOAD = "Reload the page and try again.";

/**
 * API keys for one app: the `key` tier's admin screen.
 *
 * A key reaches only the routes it is scoped to, from the routes that accept a
 * key at all. It is shown exactly once, when it is made, because only its
 * digest is stored — so the screen says that before the admin looks away, and
 * gives them a copy button rather than asking them to select a string.
 *
 * Revoked keys stay in the list, as history. The release step revokes every
 * key of an app when a different extension takes its slug, since the keys
 * were given out for the one before it; those say so, so an admin reading a
 * column of "Revoked" knows nobody here did it by hand.
 */
export default function AppApiKeysPanel({
  app,
  onCount,
}: {
  app: AppManifest;
  /** Live keys, for the segment count on the Access tab. */
  onCount: (n: number) => void;
}) {
  const toast = useToast();
  const offered = useMemo(() => keyScopes(app), [app]);
  const [keys, setKeys] = useState<AppApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [minted, setMinted] = useState<MintedAppKey | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<AppApiKey | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    listAppApiKeys(app.slug)
      .then((k) => {
        setKeys(k);
        setError(null);
        onCount(k.filter(isLiveKey).length);
      })
      .catch(() => setError(`Could not read the API keys. ${RELOAD}`));
  }, [app.slug, onCount]);

  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    reload();
  }, [reload]);

  async function revoke(k: AppApiKey) {
    setBusy(true);
    try {
      const result = await revokeAppApiKey(app.slug, k.id);
      if (result.ok) {
        toast.show("success", `Revoked "${k.label}". It stops working on its next request.`);
        setConfirmRevoke(null);
      } else {
        toast.show("error", result.message);
      }
      reload();
    } catch {
      toast.show("error", `Could not revoke the key. ${RELOAD}`);
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <p className="flex items-start gap-1.5 text-sm text-destructive">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{error}</span>
      </p>
    );
  }
  if (!keys) return <p className="text-sm text-muted-foreground">Loading API keys…</p>;

  const columns: Column<AppApiKey>[] = [
    {
      key: "key",
      header: "Key",
      cell: (k) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{k.label}</p>
          <code className="font-mono text-xs text-muted-foreground">{k.hint}…</code>
        </div>
      ),
    },
    {
      key: "scopes",
      header: "Can call",
      cell: (k) =>
        k.scopes.includes(EVERY_ROUTE) ? (
          <span className="text-sm text-foreground">Every key route</span>
        ) : (
          <ul className="space-y-0.5">
            {k.scopes.map((s) => (
              <li key={s}>
                <code className="font-mono text-xs text-foreground">{s}</code>
              </li>
            ))}
          </ul>
        ),
    },
    {
      key: "created",
      header: "Created",
      cell: (k) => (
        <span className="text-xs text-muted-foreground">
          {date(k.createdAt, "—")}
          {k.createdByName && <> by {k.createdByName}</>}
        </span>
      ),
    },
    {
      key: "used",
      header: "Last used",
      cell: (k) => (
        <span className="text-xs text-muted-foreground">{date(k.lastUsedAt, "Never")}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (k) =>
        k.revokedAt ? (
          <span className="flex flex-col items-start gap-0.5">
            <StatusPill tone="neutral">Revoked</StatusPill>
            <span className="text-xs text-muted-foreground">
              {k.revokedOnIdentityChange
                ? `${date(k.revokedAt, "")}, when a different extension took this app's slug`
                : date(k.revokedAt, "")}
            </span>
          </span>
        ) : !isLiveKey(k) ? (
          <StatusPill tone="warning">Expired</StatusPill>
        ) : (
          <span className="flex flex-col items-start gap-0.5">
            <StatusPill tone="success">Active</StatusPill>
            <span className="text-xs text-muted-foreground">
              {k.expiresAt ? `Expires ${date(k.expiresAt, "")}` : "No expiry"}
            </span>
          </span>
        ),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "right",
      cell: (k) =>
        isLiveKey(k) ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setConfirmRevoke(k)}
          >
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-sm text-muted-foreground">
          A key lets another system call {app.name}&apos;s key routes without
          signing in. Each key reaches only the routes it is given, so make one
          per system and each can be revoked on its own.
        </p>
        {!creating && !minted && (
          <Button
            variant="primary"
            size="sm"
            icon={<KeyRound className="h-4 w-4" aria-hidden />}
            onClick={() => setCreating(true)}
          >
            New API key
          </Button>
        )}
      </div>

      {minted && (
        <div className="space-y-2 rounded-md border border-warning p-4">
          <p className="text-sm font-medium text-foreground">
            Copy this key now. It is shown once, and can&apos;t be recovered.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-sm text-foreground">
              {minted.key}
            </code>
            <Button
              size="sm"
              icon={<Copy className="h-4 w-4" aria-hidden />}
              onClick={() =>
                navigator.clipboard
                  .writeText(minted.key)
                  .then(() => toast.show("success", "Key copied."))
                  .catch(() => toast.show("error", "Couldn't copy. Select the key and copy it instead."))
              }
            >
              Copy
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Send it in an <code className="font-mono">Authorization: Bearer</code> header.
          </p>
          <Button variant="ghost" size="sm" onClick={() => setMinted(null)}>
            Done
          </Button>
        </div>
      )}

      {creating && (
        <MintForm
          slug={app.slug}
          offered={offered}
          onCancel={() => setCreating(false)}
          onMinted={(m) => {
            setCreating(false);
            setMinted(m);
            reload();
          }}
        />
      )}

      {confirmRevoke && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive px-3 py-2 text-sm text-foreground">
          <span className="flex-1">
            Revoke <span className="font-semibold">{confirmRevoke.label}</span>? Anything
            using it is refused from its next request, and it can&apos;t be restored.
          </span>
          <Button
            variant="destructive"
            size="sm"
            busy={busy}
            busyLabel="Revoking…"
            onClick={() => revoke(confirmRevoke)}
          >
            Revoke key
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmRevoke(null)}>
            Cancel
          </Button>
        </div>
      )}

      {keys.length === 0 ? (
        <EmptyState
          cause="no-data"
          title="No API keys yet"
          body="Create one for each system that needs to call this app's key routes."
        />
      ) : (
        <DataTable
          rows={keys}
          columns={columns}
          rowKey={(k) => k.id}
          caption={`API keys for ${app.name}`}
        />
      )}
    </div>
  );
}

function MintForm({
  slug,
  offered,
  onCancel,
  onMinted,
}: {
  slug: string;
  offered: string[];
  onCancel: () => void;
  onMinted: (m: MintedAppKey) => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [everything, setEverything] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expiry, setExpiry] = useState("90");
  const [busy, setBusy] = useState(false);

  const scopes = everything ? [EVERY_ROUTE] : [...picked];
  const ready = label.trim().length > 0 && scopes.length > 0;

  async function mint() {
    setBusy(true);
    try {
      const result = await mintAppApiKey(slug, {
        label,
        scopes,
        expiresInDays: expiry ? Number(expiry) : null,
      });
      if (result.ok) {
        onMinted(result.minted);
        return;
      }
      toast.show("error", result.message);
    } catch {
      toast.show("error", `Could not create the key. ${RELOAD}`);
    }
    setBusy(false);
  }

  return (
    <div className="space-y-4 rounded-md border border-border p-4">
      <Field label="Label" hint="Who or what will use it, e.g. “Billing sync”.">
        {(f) => (
          <Input
            {...f}
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
          />
        )}
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-foreground">Can call</legend>
        <Checkbox
          label="Every route that accepts a key"
          hint="Includes key routes added to the app later."
          checked={everything}
          onChange={(e) => setEverything(e.target.checked)}
        />
        <div className="space-y-1.5 pl-6">
          {offered.map((s) => (
            <Checkbox
              key={s}
              label={s}
              disabled={everything}
              checked={everything || picked.has(s)}
              onChange={(e) => {
                const next = new Set(picked);
                if (e.target.checked) next.add(s);
                else next.delete(s);
                setPicked(next);
              }}
            />
          ))}
        </div>
      </fieldset>

      <Field label="Expires">
        {(f) => (
          <Select
            {...f}
            options={EXPIRY_OPTIONS}
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="w-auto"
          />
        )}
      </Field>

      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!ready}
          busy={busy}
          busyLabel="Creating…"
          onClick={mint}
        >
          Create key
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
