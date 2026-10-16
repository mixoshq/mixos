/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CARD_SHELL } from "@/components/ui/card";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  listAppAccess,
  revokeAppAccess,
  type AppAccessRow,
} from "@/lib/apps/grant-actions";
import {
  listAppApiKeys,
  revokeAppApiKey,
  type AppApiKey,
} from "@/lib/apps/api-key-actions";
import { isLiveKey } from "./app-api-keys-panel";
import { newestWins } from "./newest-wins";

/*
  A refusal comes back from the server actions as a value, with words meant for
  this screen. Anything thrown arrives without its words in production, so a
  failure that wasn't a refusal gets a fixed sentence instead.
*/
const RELOAD = "Reload the page and try again.";

/**
 * **Revoke access…** on an entry under Not in this build.
 *
 * Nobody can open an app this build doesn't carry, but its grants and API keys
 * are kept with the rest of its data, and work again the moment it comes back
 * with the same files. Someone who shouldn't have it any more, or a key that
 * leaked, can be dealt with now rather than after it returns. Revoking is all
 * there is: granting and minting need the app's manifest, which this build
 * doesn't have.
 */
export default function NotInBuildAccess({ slug, name }: { slug: string; name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Revoke access…<span className="sr-only"> ({name})</span>
      </Button>
      {open && <AccessDialog slug={slug} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

type Loaded<T> = { rows: T[] } | { failed: true } | null;

function AccessDialog({
  slug,
  name,
  onClose,
}: {
  slug: string;
  name: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const [people, setPeople] = useState<Loaded<AppAccessRow>>(null);
  const [keys, setKeys] = useState<Loaded<AppApiKey>>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The newest read wins (./newest-wins.ts), so a list can't go back to
  // showing what was just revoked.
  const [ticket] = useState(newestWins);
  const reload = useCallback(() => {
    const isNewest = ticket();
    listAppAccess(slug)
      .then((list) => {
        if (isNewest()) setPeople({ rows: list.rows });
      })
      .catch(() => {
        if (isNewest()) setPeople({ failed: true });
      });
    listAppApiKeys(slug)
      .then((all) => {
        if (isNewest()) setKeys({ rows: all.filter(isLiveKey) });
      })
      .catch(() => {
        if (isNewest()) setKeys({ failed: true });
      });
  }, [slug, ticket]);

  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    reload();
  }, [reload]);

  async function run(work: () => Promise<{ ok: true } | { ok: false; message: string }>, done: string) {
    setBusy(true);
    try {
      const result = await work();
      if (result.ok) {
        toast.show("success", done);
        setConfirming(null);
      } else {
        toast.show("error", result.message);
      }
    } catch {
      toast.show("error", `Could not revoke it. ${RELOAD}`);
    } finally {
      setBusy(false);
      reload();
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Access to ${name}`}
      subtitle="Not in this build. Revoke anyone or any key that shouldn't have it when it comes back."
      size="md"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="space-y-6">
        <Section title="People with access" loaded={people} what="who has access">
          {(rows) =>
            rows.length === 0 ? (
              <Empty>Nobody has been granted {name}.</Empty>
            ) : (
              rows.map((p) => (
                <Row
                  key={p.userId}
                  primary={p.name}
                  secondary={p.email}
                  confirming={confirming === `user:${p.userId}`}
                  busy={busy}
                  onAsk={() => setConfirming(`user:${p.userId}`)}
                  onCancel={() => setConfirming(null)}
                  question={`Revoke ${p.name}'s access to ${name}?`}
                  confirmLabel="Revoke access"
                  onConfirm={() =>
                    run(
                      () => revokeAppAccess(slug, p.userId),
                      `${p.name} no longer has ${name}.`,
                    )
                  }
                />
              ))
            )
          }
        </Section>

        <Section title="API keys" loaded={keys} what="the API keys">
          {(rows) =>
            rows.length === 0 ? (
              <Empty>No key for {name} would be accepted. Revoked and expired keys are kept as history.</Empty>
            ) : (
              rows.map((k) => (
                <Row
                  key={k.id}
                  primary={k.label}
                  secondary={`${k.hint}…`}
                  mono
                  confirming={confirming === `key:${k.id}`}
                  busy={busy}
                  onAsk={() => setConfirming(`key:${k.id}`)}
                  onCancel={() => setConfirming(null)}
                  question={`Revoke "${k.label}"? It can't be restored.`}
                  confirmLabel="Revoke key"
                  onConfirm={() =>
                    run(() => revokeAppApiKey(slug, k.id), `Revoked "${k.label}".`)
                  }
                />
              ))
            )
          }
        </Section>
      </div>
    </Dialog>
  );
}

function Section<T>({
  title,
  loaded,
  what,
  children,
}: {
  title: string;
  loaded: Loaded<T>;
  /** "who has access": what couldn't be read, in a sentence. */
  what: string;
  children: (rows: T[]) => ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </h3>
      {loaded === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : "failed" in loaded ? (
        <p className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Could not read {what}. {RELOAD}
          </span>
        </p>
      ) : (
        <div className={cn(CARD_SHELL, "divide-y divide-border overflow-hidden")}>
          {children(loaded.rows)}
        </div>
      )}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-3 text-sm text-muted-foreground">{children}</p>;
}

function Row({
  primary,
  secondary,
  mono = false,
  confirming,
  busy,
  question,
  confirmLabel,
  onAsk,
  onCancel,
  onConfirm,
}: {
  primary: string;
  secondary: string;
  mono?: boolean;
  confirming: boolean;
  busy: boolean;
  question: string;
  confirmLabel: string;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{primary}</p>
          <p
            className={cn(
              "truncate text-xs text-muted-foreground",
              mono && "font-mono",
            )}
          >
            {secondary}
          </p>
        </div>
        {!confirming && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={onAsk}>
            Revoke<span className="sr-only"> ({primary})</span>
          </Button>
        )}
      </div>
      {confirming && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-foreground">
          <span className="flex-1">{question}</span>
          <Button
            variant="destructive"
            size="sm"
            busy={busy}
            busyLabel="Revoking…"
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
