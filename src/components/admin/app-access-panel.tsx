/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, Search, UserPlus } from "lucide-react";
import type { AppManifest, RouteAuth } from "@/lib/apps/types";
import type { NeedsGrants } from "@/lib/apps/access";
import {
  keyScopes,
  surfacesFor,
  type Surface,
} from "@/lib/apps/access-surfaces";
import {
  grantAppAccess,
  listAppAccess,
  revokeAppAccess,
  searchUsersForGrant,
  setAppRoleAction,
  type AppAccessList,
  type AppAccessRow,
  type AppRoleOnlyRow,
  type GrantCandidate,
} from "@/lib/apps/grant-actions";
import { Button } from "@/components/ui/button";
import { Input, Select, type SelectOption } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { CARD_SURFACE } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/app-states";
import { useToast } from "@/components/ui/toast";
import { listAppApiKeys } from "@/lib/apps/api-key-actions";
import {
  missingConnectorSteps,
  type MissingConnector,
} from "@/lib/apps/connector-readiness";
import AppPasswordPanel from "./app-password-panel";
import AppApiKeysPanel, { isLiveKey } from "./app-api-keys-panel";
import { newestWins } from "./newest-wins";

type View = "users" | "password" | "public" | "keys";

/** Above this many rows the list gets a search box. Below it, reading wins. */
const SEARCH_THRESHOLD = 10;

const ALL_ROLES = "__all";
const STALE_ROLE = "__stale";
const NO_ROLE = "__none";

/*
  A refusal comes back from the server actions as a value, with words meant for
  this screen. Anything thrown arrives without its words in production, so a
  failure that wasn't a refusal gets a fixed sentence instead.
*/
const RELOAD = "Reload the page and try again.";

function people(n: number): string {
  return `${n} ${n === 1 ? "person" : "people"}`;
}

/**
 * The Access tab: who and what can reach this app.
 *
 * FOUR WAYS IN, ONE FILTER. A signed-in person with a grant, a visitor with
 * the app's password, anyone at all on a public surface, and a machine holding
 * an API key. They used to live in two places — grants on /admin/users, the
 * public surface and password here — so the one question an admin brings to an
 * app's access screen, "who can get in?", had no single answer.
 *
 * Every segment shows, whatever the app declares, with a count: the dialog's
 * rule is that a tab band does not reorder between apps, and the same goes for
 * a filter band. A segment with nothing in it says so and says why.
 */
export default function AppAccessPanel({
  app,
  missingConnectors,
  onAccessChange,
}: {
  app: AppManifest;
  missingConnectors: MissingConnector[];
  /** Each time the list is read: the dialog keeps its grant count from it. */
  onAccessChange?: (access: AppAccessList) => void;
}) {
  const [view, setView] = useState<View>("users");
  const [access, setAccess] = useState<AppAccessList | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  /** Live keys; null until read, "failed" when the read failed. */
  const [keyCount, setKeyCount] = useState<number | "failed" | null>(null);

  const passwordSurfaces = useMemo(() => surfacesFor(app, "password"), [app]);
  const publicSurfaces = useMemo(() => surfacesFor(app, "public"), [app]);
  const acceptsKeys = useMemo(() => keyScopes(app).length > 0, [app]);

  // The newest read wins (./newest-wins.ts): after two quick changes, the
  // answer to the first read can't land last and undo what the second shows.
  const [ticket] = useState(newestWins);
  const reload = useCallback(() => {
    const isNewest = ticket();
    listAppAccess(app.slug)
      .then((a) => {
        if (!isNewest()) return;
        setAccess(a);
        setAccessError(null);
        onAccessChange?.(a);
      })
      .catch(() => {
        if (isNewest()) setAccessError(`Could not read who has access. ${RELOAD}`);
      });
  }, [app.slug, onAccessChange, ticket]);

  // Once per open. The in-flight guard is a ref, as in the dialog: setting
  // state in the effect body is the cascading-render pattern React flags.
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    reload();
    // The API keys segment shows its count before anyone opens it. Live keys
    // only: a revoked or expired key is history, not a way in.
    if (acceptsKeys) {
      listAppApiKeys(app.slug)
        .then((keys) => setKeyCount(keys.filter(isLiveKey).length))
        .catch(() => setKeyCount("failed"));
    }
  }, [reload, acceptsKeys, app.slug]);

  const segments: { key: View; label: string; count: number | "failed" | null }[] = [
    { key: "users", label: "Users", count: access ? access.rows.length : null },
    { key: "password", label: "Password-gated", count: passwordSurfaces.length },
    { key: "public", label: "Public", count: publicSurfaces.length },
    { key: "keys", label: "API keys", count: acceptsKeys ? keyCount : 0 },
  ];

  return (
    <div className="space-y-4">
      <div
        role="group"
        aria-label="Show access by"
        className="inline-flex flex-wrap gap-0.5 rounded-md border border-border p-0.5"
      >
        {segments.map((s) => {
          const active = view === s.key;
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={active}
              onClick={() => setView(s.key)}
              className={
                active
                  ? "rounded px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground"
                  : "rounded px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
              }
            >
              {s.label} <SegmentCount count={s.count} />
            </button>
          );
        })}
      </div>

      {view === "users" && (
        <UsersView
          app={app}
          access={access}
          error={accessError}
          missingConnectors={missingConnectors}
          onChanged={reload}
        />
      )}

      {view === "password" &&
        (passwordSurfaces.length === 0 ? (
          <EmptyState
            cause="no-data"
            title="Nothing is password-gated"
            body="No page or route accepts the app password, so there is no password to set. A route opts in by declaring password as one of its auths."
          />
        ) : (
          <div className="space-y-4">
            <SurfaceList
              surfaces={passwordSurfaces}
              intro="Visitors who enter the app's password can reach these without signing in. Until a password is set nobody can unlock them: the pages say the app isn't available, and the routes refuse every request."
            />
            <AppPasswordPanel slug={app.slug} appName={app.name} />
          </div>
        ))}

      {view === "public" &&
        (publicSurfaces.length === 0 ? (
          <EmptyState
            cause="no-data"
            title="Nothing is public"
            body="Every page and route needs someone signed in, the app password, or an API key."
          />
        ) : (
          <SurfaceList
            surfaces={publicSurfaces}
            intro="Reachable by anyone on the internet, with no sign-in. A surface that also accepts a stronger auth serves its fuller view to whoever has it."
            loud
          />
        ))}

      {view === "keys" &&
        (acceptsKeys ? (
          <AppApiKeysPanel app={app} onCount={setKeyCount} />
        ) : (
          <EmptyState
            cause="no-data"
            title="No API keys"
            body="No route in this app accepts an API key, so there is nothing a key could call. A route opts in by declaring key as one of its auths."
          />
        ))}

    </div>
  );
}

/**
 * A segment's count: a number, "…" while it is read, or a mark when the read
 * failed. Not "…" then: that would say it's still coming. Opening the segment
 * reads again, and says why if it fails again. Exported for its test.
 */
export function SegmentCount({ count }: { count: number | "failed" | null }) {
  return (
    // Weight, not opacity, sets the count apart: a dimmed token falls under
    // the contrast floor (docs/apps/ux.md).
    <span className="ml-1 font-normal tabular-nums">
      {count === "failed" ? (
        <span title="Couldn't be read">
          <AlertCircle
            className="inline h-3.5 w-3.5 align-[-2px] text-destructive"
            aria-hidden
          />
          <span className="sr-only">couldn&apos;t be read</span>
        </span>
      ) : count === null ? (
        <span aria-label="loading">…</span>
      ) : (
        count
      )}
    </span>
  );
}

// ── Users ───────────────────────────────────────────────────────────────────

function UsersView({
  app,
  access,
  error,
  missingConnectors,
  onChanged,
}: {
  app: AppManifest;
  access: AppAccessList | null;
  error: string | null;
  missingConnectors: MissingConnector[];
  onChanged: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState(ALL_ROLES);
  const [confirmRevoke, setConfirmRevoke] = useState<AppAccessRow | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  const hasRoles = app.roles.length > 0;
  const roleLabel = useCallback(
    (key: string | null) =>
      app.roles.find((r) => r.key === key)?.label ?? key ?? "No role",
    [app.roles],
  );

  const changed = useCallback(() => {
    onChanged();
    // The tile's "n granted users" pill is server-rendered; refresh it too.
    router.refresh();
  }, [onChanged, router]);

  const rows = useMemo(() => access?.rows ?? [], [access]);

  // Counted by EFFECTIVE role, so a person on the default shows under it.
  const roleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = r.roleStale ? STALE_ROLE : (r.role ?? NO_ROLE);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  const roleFilterOptions: SelectOption[] = useMemo(() => {
    const opts: SelectOption[] = [{ label: "All roles", value: ALL_ROLES }];
    for (const r of app.roles) {
      opts.push({ label: `${r.label} (${roleCounts.get(r.key) ?? 0})`, value: r.key });
    }
    if (roleCounts.get(STALE_ROLE)) {
      opts.push({
        label: `Unknown role (${roleCounts.get(STALE_ROLE)})`,
        value: STALE_ROLE,
      });
    }
    if (roleCounts.get(NO_ROLE)) {
      opts.push({ label: `No role (${roleCounts.get(NO_ROLE)})`, value: NO_ROLE });
    }
    return opts;
  }, [app.roles, roleCounts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !`${r.name} ${r.email}`.toLowerCase().includes(q)) return false;
      if (roleFilter === ALL_ROLES) return true;
      if (roleFilter === STALE_ROLE) return r.roleStale;
      if (roleFilter === NO_ROLE) return !r.roleStale && r.role === null;
      return !r.roleStale && r.role === roleFilter;
    });
  }, [rows, query, roleFilter]);

  async function changeRole(row: AppAccessRow, value: string) {
    setBusyUser(row.userId);
    try {
      const result = await setAppRoleAction(app.slug, row.userId, value || null);
      if (result.ok) {
        toast.show("success", `${row.name} is now ${value ? roleLabel(value) : "on the default role"}.`);
        changed();
      } else {
        toast.show("error", result.message);
      }
    } catch {
      toast.show("error", `Could not change the role. ${RELOAD}`);
    } finally {
      setBusyUser(null);
    }
  }

  // Someone with a role kept from when the app was global: granting keeps
  // the role while the app still declares it, and clearing removes the row.
  async function grantKept(row: AppRoleOnlyRow) {
    setBusyUser(row.userId);
    const keep = row.role !== null && !row.roleStale ? row.role : null;
    try {
      const result = await grantAppAccess(app.slug, row.userId, keep);
      if (result.ok) {
        toast.show(
          result.changed ? "success" : "warning",
          result.changed
            ? `${row.name} now has ${app.name}${keep ? `, as ${roleLabel(keep)}` : ""}.`
            : `${row.name} already had ${app.name}. Their role wasn't changed.`,
        );
        changed();
      } else {
        toast.show("error", result.message);
      }
    } catch {
      toast.show("error", `Could not grant access. ${RELOAD}`);
    } finally {
      setBusyUser(null);
    }
  }

  async function clearKept(row: AppRoleOnlyRow) {
    setBusyUser(row.userId);
    try {
      const result = await setAppRoleAction(app.slug, row.userId, null);
      if (result.ok) {
        toast.show("success", `Cleared ${row.name}'s role in ${app.name}.`);
        changed();
      } else {
        toast.show("error", result.message);
      }
    } catch {
      toast.show("error", `Could not clear the role. ${RELOAD}`);
    } finally {
      setBusyUser(null);
    }
  }

  async function revoke(row: AppAccessRow) {
    setBusyUser(row.userId);
    try {
      const result = await revokeAppAccess(app.slug, row.userId);
      if (result.ok) {
        toast.show(
          result.changed ? "success" : "warning",
          result.changed
            ? `${row.name} no longer has ${app.name}.`
            : `${row.name} didn't have ${app.name}, so there was nothing to revoke.`,
        );
        setConfirmRevoke(null);
        changed();
      } else {
        toast.show("error", result.message);
      }
    } catch {
      toast.show("error", `Could not revoke access. ${RELOAD}`);
    } finally {
      setBusyUser(null);
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
  if (!access) {
    return <p className="text-sm text-muted-foreground">Loading who has access…</p>;
  }

  const blocked = !access.global && missingConnectors.length > 0;

  const columns: Column<AppAccessRow>[] = [
    {
      key: "person",
      header: "Person",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{r.name}</p>
          <p className="truncate text-xs text-muted-foreground">{r.email}</p>
        </div>
      ),
    },
    ...(hasRoles
      ? [
          {
            key: "role",
            header: "Role",
            cell: (r: AppAccessRow) => (
              <RoleCell
                app={app}
                row={r}
                busy={busyUser === r.userId}
                onChange={(v) => changeRole(r, v)}
              />
            ),
          } satisfies Column<AppAccessRow>,
        ]
      : []),
    ...(!access.global
      ? [
          {
            key: "granted",
            header: "Granted",
            cell: (r: AppAccessRow) => (
              <span className="text-xs text-muted-foreground">
                {r.grantedAt ? new Date(r.grantedAt).toLocaleDateString() : "—"}
                {r.grantedBy && <> by {r.grantedBy}</>}
              </span>
            ),
          } satisfies Column<AppAccessRow>,
          {
            key: "actions",
            header: <span className="sr-only">Actions</span>,
            align: "right",
            cell: (r: AppAccessRow) => (
              <Button
                variant="ghost"
                size="sm"
                disabled={busyUser !== null}
                onClick={() => setConfirmRevoke(r)}
              >
                Revoke
              </Button>
            ),
          } satisfies Column<AppAccessRow>,
        ]
      : []),
  ];

  return (
    <div className="space-y-3">
      {access.global && (
        <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-foreground">
          Everyone on this instance has {app.name}: it is a global app, so access
          is not granted or revoked per person.
          {hasRoles && " Roles still apply, and are set here."}
        </p>
      )}

      {access.needsGrants && (
        <NeedsGrantsBanner
          appName={app.name}
          needsGrants={access.needsGrants}
          roleOnly={access.roleOnly.length}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {rows.length > SEARCH_THRESHOLD && (
          <div className="relative min-w-[14rem] flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              aria-label="Search people"
              placeholder="Search by name or email"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="pl-8"
            />
          </div>
        )}
        {hasRoles && rows.length > 0 && (
          <Select
            aria-label="Filter by role"
            options={roleFilterOptions}
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="w-auto"
          />
        )}
        {!access.global && !blocked && (
          <GrantPopover app={app} onGranted={changed} />
        )}
      </div>

      {blocked && (
        <p className="flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            {missingConnectorSteps(missingConnectors)} before granting{" "}
            {app.name} to anyone. Until then it can&apos;t serve a request for
            whoever you give it to.
          </span>
        </p>
      )}

      {confirmRevoke && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive px-3 py-2 text-sm text-foreground">
          <span className="flex-1">
            Revoke <span className="font-semibold">{confirmRevoke.name}</span>&apos;s
            access? {app.name} leaves their dashboard, and their MCP access to it
            ends on the next call.
          </span>
          <Button
            variant="destructive"
            size="sm"
            busy={busyUser === confirmRevoke.userId}
            busyLabel="Revoking…"
            onClick={() => revoke(confirmRevoke)}
          >
            Revoke access
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setConfirmRevoke(null)}>
            Cancel
          </Button>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState
          cause="no-data"
          title="Nobody has this app yet"
          body={
            blocked
              ? "Get its connectors ready first, then grant it to the people who need it."
              : "Grant it to the people who need it. It then appears in their App Manager."
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          cause="no-filter"
          body="No one matches this search and role."
          action={{
            label: "Clear filters",
            onClick: () => {
              setQuery("");
              setRoleFilter(ALL_ROLES);
            },
          }}
        />
      ) : (
        <DataTable
          rows={visible}
          columns={columns}
          rowKey={(r) => r.userId}
          caption={`People with access to ${app.name}`}
        />
      )}

      {rows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {visible.length === rows.length
            ? people(rows.length)
            : `${visible.length} of ${people(rows.length)}`}
        </p>
      )}

      {access.roleOnly.length > 0 && (
        <RoleOnlyList
          app={app}
          rows={access.roleOnly}
          roleLabel={roleLabel}
          blocked={blocked}
          busyUser={busyUser}
          onGrant={grantKept}
          onClear={clearKept}
        />
      )}
    </div>
  );
}

/**
 * Over the Users list when people lost the app, worded for why: it stopped
 * being global, or roles from before were decided to be only roles. Exported
 * for its test.
 */
export function NeedsGrantsBanner({
  appName,
  needsGrants,
  roleOnly,
}: {
  appName: string;
  needsGrants: NeedsGrants;
  /** How many people have a role and no access, listed below it. */
  roleOnly: number;
}) {
  return (
    <p className="flex items-start gap-2 rounded-md border border-warning px-3 py-2 text-sm text-foreground">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
      <span>
        {needsGrants.reason === "global-ended"
          ? `${appName} isn't global any more, so only the people granted it have it.`
          : `Some people had ${appName} through a role and no grant. A role isn't access, so they don't have it now.`}
        {roleOnly === 1 && " One person has a role from before, listed below, and no access."}
        {roleOnly > 1 && ` ${roleOnly} people have a role from before, listed below, and no access.`}
      </span>
    </p>
  );
}

/**
 * People with a role in this app and no access to it.
 *
 * The app was global when they were given the role. A role isn't access
 * (migration 0013): once the app stopped being global, they no longer had it,
 * and won't until an admin grants it to them. Listed apart from the people who
 * have it, so nobody reads a role as a grant.
 */
function RoleOnlyList({
  app,
  rows,
  roleLabel,
  blocked,
  busyUser,
  onGrant,
  onClear,
}: {
  app: AppManifest;
  rows: AppRoleOnlyRow[];
  roleLabel: (key: string | null) => string;
  /** A connector the app needs isn't ready, so granting is refused. */
  blocked: boolean;
  busyUser: string | null;
  onGrant: (row: AppRoleOnlyRow) => void;
  onClear: (row: AppRoleOnlyRow) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2 pt-2">
      <h4 id={headingId} className="text-sm font-medium text-foreground">
        A role, and no access ({rows.length})
      </h4>
      <p className="text-xs text-muted-foreground">
        Given a role while {app.name} was global. They don&apos;t have it until
        it&apos;s granted to them. Granting keeps their role while {app.name}{" "}
        still declares it.
      </p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {rows.map((r) => (
          <li
            key={r.userId}
            className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">{r.name}</p>
              <p className="truncate text-xs text-muted-foreground">
                {r.email}
                {r.email && " · "}
                {r.roleStale
                  ? `Unknown role: ${r.role}`
                  : r.role
                    ? roleLabel(r.role)
                    : "No role of their own"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="primary"
                size="sm"
                disabled={blocked || busyUser !== null}
                title={blocked ? "Get its connectors ready first" : undefined}
                onClick={() => onGrant(r)}
              >
                Grant<span className="sr-only"> {app.name} to {r.name}</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busyUser !== null}
                onClick={() => onClear(r)}
              >
                Clear role<span className="sr-only"> for {r.name}</span>
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One person's role. The effective role is what shows; an inherited one is
 * marked "(default)" so it can be told from one an admin assigned, and choosing
 * Default clears an assignment rather than writing the default's key — which
 * would quietly stop following the manifest if the default ever changed.
 */
function RoleCell({
  app,
  row,
  busy,
  onChange,
}: {
  app: AppManifest;
  row: AppAccessRow;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const defaultLabel = app.defaultRole
    ? `Default (${app.roles.find((r) => r.key === app.defaultRole)?.label ?? app.defaultRole})`
    : "No role";
  const options: SelectOption[] = [
    { label: defaultLabel, value: "" },
    ...app.roles.map((r) => ({ label: r.label, value: r.key })),
  ];
  if (row.roleStale && row.role) {
    options.push({ label: `Unknown role: ${row.role}`, value: row.role });
  }
  const value = row.roleSource === "assigned" && row.role ? row.role : "";

  return (
    <div className="flex items-center gap-2">
      <Select
        aria-label={`Role for ${row.name}`}
        options={options}
        value={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-auto min-w-[9rem]"
      />
      {row.roleStale && (
        <span className="flex items-center gap-1 text-xs text-warning">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden />
          Not declared — no role applies
        </span>
      )}
    </div>
  );
}

/**
 * Grant to someone new, from a small overlay anchored under the button.
 *
 * A type-ahead over every user by name or email — searched on the server, and
 * excluding people who already have the app — then a role when the app
 * declares any. The search box is a combobox: the arrow keys move through the
 * matches and Enter picks one, so granting never needs the mouse.
 *
 * ESCAPE CLOSES THIS LAYER AND ONLY THIS ONE. The app dialog underneath closes
 * on Escape from a document listener, so the key is caught here in the capture
 * phase and stopped: one press, one layer. An outside click closes it too —
 * including a click elsewhere in the dialog, which stays open.
 */
function GrantPopover({
  app,
  onGranted,
}: {
  app: AppManifest;
  onGranted: () => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GrantCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchFailed, setSearchFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [picked, setPicked] = useState<GrantCandidate | null>(null);
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const roleRef = useRef<HTMLSelectElement>(null);
  const grantRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const listId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setQuery("");
    setResults([]);
    setSearching(false);
    setSearchFailed(false);
    setActive(0);
    setPicked(null);
    setRole("");
    setBusy(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close(true);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  // Focus follows the step: the search box while choosing a person, then the
  // role (or the Grant button, for an app without roles) once one is chosen.
  useEffect(() => {
    if (open && !picked) inputRef.current?.focus();
  }, [open, picked]);
  useEffect(() => {
    if (picked) (roleRef.current ?? grantRef.current)?.focus();
  }, [picked]);

  // Debounced; the latest query wins, so a slow early response cannot
  // overwrite the results for what the admin has typed since.
  const latest = useRef("");
  useEffect(() => {
    const q = query.trim();
    latest.current = q;
    if (!open || !q || picked) return;
    const t = setTimeout(() => {
      setSearching(true);
      searchUsersForGrant(app.slug, q)
        .then((r) => {
          if (latest.current !== q) return;
          setResults(r);
          setSearchFailed(false);
          setActive(0);
        })
        .catch(() => {
          if (latest.current !== q) return;
          setResults([]);
          setSearchFailed(true);
        })
        .finally(() => {
          if (latest.current === q) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(t);
  }, [open, query, picked, app.slug]);

  function pick(u: GrantCandidate) {
    setPicked(u);
    setResults([]);
  }

  function onSearchKey(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(results[Math.min(active, results.length - 1)]);
    }
  }

  async function grant() {
    if (!picked) return;
    setBusy(true);
    try {
      const result = await grantAppAccess(app.slug, picked.userId, role || null);
      if (result.ok) {
        if (result.changed) {
          toast.show("success", `${picked.name} now has ${app.name}.`);
        } else {
          // Another admin granted it since this list was read. Their grant,
          // and the role it gave, stand.
          toast.show(
            "warning",
            `${picked.name} already had ${app.name}. Their role wasn't changed.`,
          );
        }
        close(true);
        onGranted();
        return;
      }
      toast.show("error", result.message);
    } catch {
      toast.show("error", `Could not grant access. ${RELOAD}`);
    }
    setBusy(false);
  }

  const defaultLabel = app.defaultRole
    ? `Default (${app.roles.find((r) => r.key === app.defaultRole)?.label ?? app.defaultRole})`
    : "No role";
  const showList = !picked && query.trim() !== "";
  const activeId =
    showList && results.length > 0
      ? `${listId}-${Math.min(active, results.length - 1)}`
      : undefined;

  return (
    <div ref={rootRef} className="relative ml-auto">
      <Button
        ref={buttonRef}
        variant="primary"
        size="sm"
        icon={<UserPlus className="h-4 w-4" aria-hidden />}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        Grant access
      </Button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={`Grant ${app.name}`}
          className={cn(
            "mix-popover",
            CARD_SURFACE,
            "absolute right-0 z-30 mt-1 w-[22rem] max-w-[calc(100vw-3rem)] space-y-3 p-3 shadow-lg",
          )}
        >
          {picked ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">Person</p>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {picked.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {picked.email}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPicked(null);
                    setQuery("");
                  }}
                  className="shrink-0 text-xs font-medium text-primary underline-offset-2 hover:underline"
                >
                  Change
                </button>
              </div>
            </div>
          ) : (
            <Field
              label="Name or email"
              hint="People who already have this app aren't listed."
            >
              {(f) => (
                <div>
                  <Input
                    {...f}
                    ref={inputRef}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded={showList}
                    aria-controls={listId}
                    aria-activedescendant={activeId}
                    autoComplete="off"
                    placeholder="Start typing to search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onSearchKey}
                  />
                  {showList && (
                    <ul
                      id={listId}
                      role="listbox"
                      aria-label="Matching people"
                      className="mt-1 max-h-56 overflow-y-auto rounded-md border border-border"
                    >
                      {searching && results.length === 0 ? (
                        <li role="presentation" className="px-3 py-2 text-sm text-muted-foreground">
                          Searching…
                        </li>
                      ) : searchFailed ? (
                        <li role="presentation" className="px-3 py-2 text-sm text-destructive">
                          Couldn&apos;t search. {RELOAD}
                        </li>
                      ) : results.length === 0 ? (
                        <li role="presentation" className="px-3 py-2 text-sm text-muted-foreground">
                          No one without access matches &ldquo;{query.trim()}&rdquo;.
                        </li>
                      ) : (
                        results.map((u, i) => (
                          <li
                            key={u.userId}
                            id={`${listId}-${i}`}
                            role="option"
                            aria-selected={i === active}
                            // Keep focus in the search box, so the arrow keys
                            // still work after a mouse hover.
                            onMouseDown={(e) => e.preventDefault()}
                            onMouseEnter={() => setActive(i)}
                            onClick={() => pick(u)}
                            className={cn(
                              "flex cursor-pointer items-baseline justify-between gap-3 px-3 py-2 text-sm text-foreground",
                              i === active && "bg-muted",
                            )}
                          >
                            <span className="truncate font-medium">{u.name}</span>
                            {/* Muted text on a muted row is under 4.5:1, so the
                                highlighted row's email takes full ink. */}
                            <span
                              className={cn(
                                "truncate text-xs",
                                i === active ? "text-foreground" : "text-muted-foreground",
                              )}
                            >
                              {u.email}
                            </span>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </div>
              )}
            </Field>
          )}

          {picked && app.roles.length > 0 && (
            <Field label="Role">
              {(f) => (
                <Select
                  {...f}
                  ref={roleRef}
                  options={[
                    { label: defaultLabel, value: "" },
                    ...app.roles.map((r) => ({ label: r.label, value: r.key })),
                  ]}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                />
              )}
            </Field>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={() => close(true)}>
              Cancel
            </Button>
            <Button
              ref={grantRef}
              variant="primary"
              size="sm"
              disabled={!picked}
              busy={busy}
              busyLabel="Granting…"
              onClick={grant}
            >
              Grant
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Surfaces ────────────────────────────────────────────────────────────────

// One badge per accepted auth, loudest first, so the widest exposure is the
// first thing read. A surface accepting several auths genuinely is several
// things at once, and collapsing it to one badge would hide exactly that.
const AUTH_ORDER: RouteAuth[] = ["public", "password", "key", "signed-in", "session"];

function badgeFor(auth: RouteAuth): { label: string; className: string } {
  switch (auth) {
    case "public":
      return { label: "Public", className: "bg-success text-success-foreground" };
    case "password":
      return { label: "Password", className: "bg-warning text-warning-foreground" };
    case "key":
      return { label: "API key", className: "bg-primary text-primary-foreground" };
    case "signed-in":
      return { label: "Signed in", className: "bg-muted text-foreground" };
    case "session":
    default:
      return { label: "Session", className: "bg-muted text-foreground" };
  }
}

function SurfaceList({
  surfaces,
  intro,
  loud = false,
}: {
  surfaces: Surface[];
  intro: string;
  /** For the public list: says so in the warning tone, not as small print. */
  loud?: boolean;
}) {
  const pages = surfaces.filter((s) => s.kind === "page");
  const api = surfaces.filter((s) => s.kind === "api");
  return (
    <div className="rounded-md border border-border p-4">
      <p
        className={
          loud
            ? "flex items-start gap-2 text-sm text-foreground"
            : "text-sm text-muted-foreground"
        }
      >
        {loud && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />}
        <span>{intro}</span>
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {[
          { title: "Pages", list: pages },
          { title: "API routes", list: api },
        ]
          .filter((g) => g.list.length > 0)
          .map((g) => (
            <div key={g.title}>
              <p className="text-xs font-medium text-foreground">{g.title}</p>
              <ul className="mt-1 space-y-1 text-xs">
                {g.list.map((s) => (
                  <li key={s.key} className="flex items-center justify-between gap-2">
                    <code className="truncate rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                      {s.label}
                    </code>
                    <span className="flex shrink-0 flex-wrap justify-end gap-1">
                      {[...s.auths]
                        .sort((a, b) => AUTH_ORDER.indexOf(a) - AUTH_ORDER.indexOf(b))
                        .map((auth) => {
                          const b = badgeFor(auth);
                          return (
                            <span
                              key={auth}
                              className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${b.className}`}
                            >
                              {b.label}
                            </span>
                          );
                        })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </div>
  );
}
