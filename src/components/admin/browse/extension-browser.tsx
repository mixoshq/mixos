/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Search, ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CARD_SHELL } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  searchRepositoryAction,
  type SearchOutcome,
} from "@/lib/repository/actions";
import { sourceHost, type Provenance } from "@/lib/repository/provenance";
import {
  KIND_LABEL,
  SORT_KEYS,
  SORT_LABEL,
  type ExtensionKind,
  type ExtensionSummary,
  type SortKey,
} from "@/lib/repository/types";
import Notice from "../pending/notice";
import ReviewDialog, { type PendingTarget } from "../pending/review-dialog";
import ExtensionCard from "./extension-card";
import RegisterDialog from "./register-dialog";

/**
 * Browse one kind of extension in the mixos.org repository.
 *
 * ── SEARCH RUNS ON THE SERVER, NOT IN THE BROWSER ───────────────────────────
 *
 * The registry grids next door filter an array they already hold. This cannot:
 * the catalogue is remote and paginated, so every keystroke's answer has to
 * come from mixos.org. That difference is why this is a server action behind a
 * debounce rather than a `useMemo`, and it is also why the browser never talks
 * to mixos.org itself — the request goes through this instance, which is what
 * keeps the admin gate on the server side of it.
 *
 * ── THE UNREACHABLE STATE IS A FIRST-CLASS SCREEN ───────────────────────────
 *
 * mixos.org's public search API is specified but not yet deployed, so "no
 * answer" is the state most instances will meet first. It gets its own panel
 * naming the origin that was tried, because an admin looking at an empty grid
 * cannot otherwise tell the difference between a repository that is down, a
 * `MIXOS_REPOSITORY_URL` pointing somewhere wrong, and a catalogue with nothing
 * in it.
 */
export default function ExtensionBrowser({
  kind,
  repositoryOrigin,
  repositoryOverridable,
  installed: installedAtLoad,
  pendingSlugs,
  installable,
  installableTone,
}: {
  kind: ExtensionKind;
  /** Origin of the repository being browsed, for links out to its listings. */
  repositoryOrigin: string;
  /**
   * Whether `MIXOS_REPOSITORY_URL` can point this instance somewhere else. A
   * built deployment searches only mixos.org or a catalogue on its own machine
   * (src/lib/repository/client.ts), so suggesting the variable there would send
   * an admin to a setting that is ignored.
   */
  repositoryOverridable: boolean;
  /**
   * Already in this build, by slug, and where each came from. Server-rendered
   * from the generated registries and the install records.
   */
  installed: Record<string, Provenance>;
  /** Installed into `.mixos/pending/` and not registered yet. */
  pendingSlugs: string[];
  /** `null` when this deployment can install; why it doesn't otherwise. */
  installable: string | null;
  /**
   * `info` for a built deployment, which doesn't install by design; `warning`
   * for a checkout that can't, which is something to fix.
   */
  installableTone: "info" | "warning";
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("relevance");
  const [page, setPage] = useState(1);
  const [outcome, setOutcome] = useState<SearchOutcome | null>(null);
  const [pending, startTransition] = useTransition();
  // The extension to install, then the pending install to review and register.
  const [chosen, setChosen] = useState<ExtensionSummary | null>(null);
  const [reviewing, setReviewing] = useState<PendingTarget | null>(null);
  const [installed, setInstalled] = useState(() => new Map(Object.entries(installedAtLoad)));
  const [pendingNow, setPendingNow] = useState(() => new Set(pendingSlugs));

  // Guards against an earlier, slower search overwriting a later one — the
  // classic out-of-order-response bug, which a debounce alone does not prevent.
  const latest = useRef(0);

  const run = useCallback(
    (q: string, s: SortKey, p: number) => {
      const ticket = ++latest.current;
      startTransition(async () => {
        const res = await searchRepositoryAction({ kind, q, sort: s, page: p });
        if (ticket === latest.current) setOutcome(res);
      });
    },
    [kind],
  );

  useEffect(() => {
    // Typing debounce. The first render passes through it too, which is what
    // gives the empty query its initial "most installed" listing.
    const t = setTimeout(() => run(query, sort, page), query ? 300 : 0);
    return () => clearTimeout(t);
  }, [query, sort, page, run]);

  const label = KIND_LABEL[kind];
  // The origin, not a hardcoded "mixos.org": an instance pointed at a local
  // checkout or a mirror should say where it is actually searching.
  const host = repositoryOrigin.replace(/^https?:\/\//, "");

  /** Just installed (a theme) or registered here, from the catalogue being browsed. */
  const installedNow = useCallback(
    (slug: string, version: string) =>
      setInstalled((m) =>
        new Map(m).set(slug, { from: "catalogue", host: sourceHost(repositoryOrigin), version, modified: false }),
      ),
    [repositoryOrigin],
  );

  return (
    <>
      {installable && (
        <div className="mb-4">
          <Notice tone={installableTone}>{installable}</Notice>
        </div>
      )}

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            placeholder={`Search ${label.many.toLowerCase()} on ${host}...`}
            aria-label={`Search ${label.many.toLowerCase()} on ${host}`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-lg border border-input bg-background py-2 pl-9 pr-3 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <Select
          aria-label="Sort results"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as SortKey);
            setPage(1);
          }}
          className="sm:w-52"
          options={SORT_KEYS.map((k) => ({ value: k, label: SORT_LABEL[k] }))}
        />
      </div>

      {outcome === null || (pending && outcome === null) ? (
        <Panel>
          Searching {label.many.toLowerCase()} on {host}…
        </Panel>
      ) : !outcome.ok ? (
        <div className={cn(CARD_SHELL, "p-6")}>
          <div className="flex gap-3">
            <ServerCrash
              className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
              aria-hidden
            />
            <div>
              <p className="font-medium text-foreground">
                {outcome.unreachable
                  ? `Could not reach ${outcome.origin}.`
                  : `${outcome.origin} could not answer that search.`}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {outcome.message}
              </p>
              {outcome.unreachable && repositoryOverridable && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Set{" "}
                  <code className="font-mono text-xs">
                    MIXOS_REPOSITORY_URL
                  </code>{" "}
                  to point this instance at a different repository.
                </p>
              )}
              <Button
                className="mt-4"
                size="sm"
                busy={pending}
                onClick={() => run(query, sort, page)}
              >
                Try again
              </Button>
            </div>
          </div>
        </div>
      ) : outcome.items.length === 0 ? (
        <Panel>
          {query
            ? `No ${label.many.toLowerCase()} on ${host} match “${query}”.`
            : `The repository lists no ${label.many.toLowerCase()} yet.`}
        </Panel>
      ) : (
        <>
          {/* The registry grids' layout, so crossing from one to the other is
              not a change of scenery. */}
          <div
            className={cn(
              "grid gap-4 sm:grid-cols-2 lg:grid-cols-3",
              pending && "opacity-60 transition-opacity",
            )}
          >
            {outcome.items.map((e) => (
              <ExtensionCard
                key={`${e.kind}/${e.slug}`}
                extension={e}
                repositoryOrigin={repositoryOrigin}
                installed={installed.get(e.slug) ?? null}
                pendingSlugs={pendingNow}
                onInstall={setChosen}
                onReview={(extension) =>
                  setReviewing({
                    kind: extension.kind as PendingTarget["kind"],
                    slug: extension.slug,
                    name: extension.name,
                  })
                }
              />
            ))}
          </div>

          {outcome.totalPages > 1 && (
            <div className="mt-6 flex items-center justify-center gap-3 text-sm">
              <Button
                size="sm"
                disabled={outcome.page <= 1 || pending}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="text-muted-foreground">
                Page {outcome.page} of {outcome.totalPages} · {outcome.total}{" "}
                results
              </span>
              <Button
                size="sm"
                disabled={outcome.page >= outcome.totalPages || pending}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      {/* Keyed so each choice gets a fresh dialog — see the effect inside it. */}
      <RegisterDialog
        key={chosen ? `install:${chosen.kind}/${chosen.slug}` : "install:none"}
        extension={chosen}
        notInstallable={installable ? { message: installable, tone: installableTone } : null}
        onClose={() => setChosen(null)}
        onInstalled={(extension, pending, version) => {
          if (pending) setPendingNow((s) => new Set(s).add(extension.slug));
          else installedNow(extension.slug, version);
        }}
        onReview={(target) => {
          setChosen(null);
          setReviewing(target);
        }}
      />
      {/* An app or a connector installed into pending: review, then Register. */}
      <ReviewDialog
        key={reviewing ? `review:${reviewing.kind}/${reviewing.slug}` : "review:none"}
        target={reviewing}
        onClose={() => setReviewing(null)}
        onRegistered={(slug, version) => {
          setPendingNow((s) => {
            const next = new Set(s);
            next.delete(slug);
            return next;
          });
          installedNow(slug, version);
        }}
      />
    </>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn(CARD_SHELL, "p-5 text-center text-muted-foreground")}>
      {children}
    </div>
  );
}
