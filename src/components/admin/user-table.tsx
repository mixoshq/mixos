/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Plus, Search } from "lucide-react";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/ui/status";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { AppManifest } from "@/lib/apps/types";
import UserDialog from "./user-dialog";
import AddUserDialog from "./add-user-dialog";

export interface UserRow {
  id: string;
  display_name: string;
  email: string;
  is_admin: boolean;
  grantedSlugs: string[];
  grantedActiveCount: number;
  installedActiveCount: number;
  /** Effective role key per granted slug (defaultRole when none set). */
  roleBySlug: Record<string, string | null>;
  /**
   * The role stored per granted slug: null when the user has none of their
   * own and follows the app's defaultRole.
   */
  assignedRoleBySlug: Record<string, string | null>;
  /**
   * Apps that aren't global, where the user has a role kept from when the app
   * was, and no access: slug → that role, null for the default.
   */
  roleOnlyBySlug: Record<string, string | null>;
}

/** What a grant or revoke from the users page changed. */
export interface GrantToggleOutcome {
  /** False when the person already had the app, or didn't have it to revoke. */
  changed: boolean;
}

interface Props {
  users: UserRow[];
  grantableApps: AppManifest[];
  /**
   * Slug → the connectors it needs that nobody has configured, already
   * formatted for display. A slug present here cannot be granted.
   */
  blockedBySlug: Record<string, string>;
  /** The admin doing the looking, so their own row cannot demote itself. */
  currentAdminId: string;
  toggleAction: (formData: FormData) => Promise<GrantToggleOutcome>;
  setRoleAction: (formData: FormData) => void | Promise<void>;
}

type SortKey = "name" | "email" | "apps";
type SortDir = "asc" | "desc";

/**
 * The user registry: a table you read down, and a record you open.
 *
 * WHY A TABLE AND NOT THE ACCORDION IT REPLACED. The accordion could show one
 * user's app grants at a time and nothing else — no way to compare two people,
 * and every other fact about an account (its name, its address, whether it is
 * an admin) was unreachable from the page that lists accounts. Splitting it
 * into a scannable table plus a per-user dialog is the same split the app and
 * connector registries already use, so all three admin registries now behave
 * the same way.
 */
export default function UserTable({
  users,
  grantableApps,
  blockedBySlug,
  currentAdminId,
  toggleAction,
  setRoleAction,
}: Props) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  /*
    The open user is looked up from `users` on every render rather than being
    held in state as a row. The dialog writes through server actions that
    revalidate this page, so the props change underneath it — a captured copy
    would keep showing the name and the grants as they were when it opened.
  */
  const openUser = users.find((u) => u.id === openUserId) ?? null;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? users.filter(
          (u) =>
            u.display_name.toLowerCase().includes(q) ||
            u.email.toLowerCase().includes(q),
        )
      : users;

    const dir = sortDir === "asc" ? 1 : -1;
    // Sorted into a copy: `users` is a prop, and sorting it in place would
    // mutate the array the server handed down.
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case "email":
          return dir * a.email.localeCompare(b.email);
        case "apps":
          return (
            dir * (a.grantedActiveCount - b.grantedActiveCount) ||
            a.display_name.localeCompare(b.display_name)
          );
        default:
          return dir * a.display_name.localeCompare(b.display_name);
      }
    });
  }, [users, query, sortKey, sortDir]);

  /** Clicking the active column flips direction; a new column starts ascending. */
  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  function sortableHeader(key: SortKey, label: string): ReactNode {
    const active = key === sortKey;
    const Icon = !active ? ChevronsUpDown : sortDir === "asc" ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        onClick={() => toggleSort(key)}
        // The direction has to reach a screen reader too — an arrow glyph in a
        // header cell is invisible to one, and `aria-sort` on the <th> is not
        // reachable from here since DataTable owns the cell.
        aria-label={`Sort by ${label}${
          active ? (sortDir === "asc" ? ", ascending" : ", descending") : ""
        }`}
        className="inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {label}
        <Icon
          aria-hidden
          className={cn("h-3 w-3", active ? "text-foreground" : "opacity-60")}
        />
      </button>
    );
  }

  const columns: Column<UserRow>[] = [
    {
      key: "name",
      header: sortableHeader("name", "Name"),
      cell: (u) => (
        <span className="font-medium text-foreground">{u.display_name}</span>
      ),
    },
    {
      key: "email",
      header: sortableHeader("email", "Email"),
      cell: (u) => <span className="text-muted-foreground">{u.email}</span>,
    },
    {
      key: "role",
      header: "Access",
      cell: (u) =>
        u.is_admin ? (
          <StatusPill tone="success">Admin</StatusPill>
        ) : (
          // An em dash, not an empty cell: a blank reads as missing data rather
          // than as "no, this person is not an admin".
          <span className="text-muted-foreground">—</span>
        ),
      className: "w-32",
    },
    {
      key: "apps",
      header: sortableHeader("apps", "Apps"),
      align: "right",
      cell: (u) => (
        <span
          className="whitespace-nowrap text-muted-foreground"
          title="Apps granted, and how many of those this user has installed"
        >
          <span className="font-medium text-foreground">
            {u.grantedActiveCount}
          </span>{" "}
          granted · {u.installedActiveCount} installed
        </span>
      ),
      className: "w-56",
    },
  ];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or email"
            aria-label="Search users by name or email"
            className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <Button
          variant="primary"
          onClick={() => setAddOpen(true)}
          icon={<Plus className="h-4 w-4" aria-hidden />}
        >
          Add User
        </Button>
      </div>

      {users.length === 0 ? (
        <div
          className={cn(CARD_SHELL, "px-6 py-8 text-center text-muted-foreground")}
        >
          No users yet. Add the first one with the button above.
        </div>
      ) : visible.length === 0 ? (
        <div
          className={cn(CARD_SHELL, "px-6 py-8 text-center text-muted-foreground")}
        >
          No user matches &ldquo;{query}&rdquo;.
        </div>
      ) : (
        <DataTable
          rows={visible}
          columns={columns}
          rowKey={(u) => u.id}
          onRowClick={(u) => setOpenUserId(u.id)}
          caption="Users, with their admin status and app access. Select a row to open that user."
        />
      )}

      {/* Keyed by user id so switching rows remounts the panels — otherwise the
          password fields and the loaded activity of the previous person survive
          into the next one's dialog. */}
      {openUser && (
        <UserDialog
          key={openUser.id}
          user={openUser}
          open
          onClose={() => setOpenUserId(null)}
          grantableApps={grantableApps}
          blockedBySlug={blockedBySlug}
          currentAdminId={currentAdminId}
          toggleAction={toggleAction}
          setRoleAction={setRoleAction}
        />
      )}

      <AddUserDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </>
  );
}
