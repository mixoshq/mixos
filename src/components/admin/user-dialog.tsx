/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useSession } from "next-auth/react";
import { ShieldCheck, User as UserIcon } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { StatusPill } from "@/components/ui/status";
import FolderTabs from "@/components/ui/folder-tabs";
import { useToast } from "@/components/ui/toast";
import { CARD_SHELL } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  adminUpdateProfile,
  adminSetPassword,
  adminSetIsAdmin,
  getUserActivity,
} from "@/lib/admin/user-actions";
import {
  INITIAL_ACCOUNT_STATE,
  type AccountActionState,
} from "@/lib/account/state";
import type { AdminAuditRow } from "@/lib/apps/admin-audit";
import type { AppManifest, AppRole } from "@/lib/apps/types";
import type { GrantToggleOutcome, UserRow } from "./user-table";

type DialogTab = "profile" | "security" | "access" | "activity";

/**
 * Every tab, on every user, always — the same rule the app registry's dialog
 * states. This is a list an admin reads down, opening person after person, and
 * a band whose membership changed per user would make "check their apps" a
 * fresh hunt each time. Empty states carry what a missing tab would have.
 */
const TABS: Array<{ key: DialogTab; label: string }> = [
  { key: "profile", label: "Profile" },
  { key: "security", label: "Security" },
  { key: "access", label: "App Access" },
  { key: "activity", label: "Activity" },
];

/** Shared input chrome, so five fields across three tabs cannot drift. */
const INPUT_CLASS =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm focus:outline-none focus:ring-1 focus:ring-ring";

/**
 * The outcome of one form, inline and next to the form that produced it.
 *
 * Not a toast. `toast.tsx` reserves those for confirmation of something that
 * already happened and explicitly rules out using them for anything the user
 * must act on — which is exactly what "that email is already in use" and "this
 * is the only administrator" are.
 */
function Banner({ state }: { state: AccountActionState }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground"
      >
        {state.error}
      </p>
    );
  }
  if (state.success) {
    return (
      <p
        role="status"
        className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-sm text-foreground"
      >
        {state.success}
      </p>
    );
  }
  return null;
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
      {children}
    </h3>
  );
}

/**
 * An audit action rendered as a sentence rather than a dotted verb.
 *
 * `user.grant.add` is the right thing to store and the wrong thing to show: the
 * tab exists so an admin can answer "how did this account get its access", and
 * that answer should not require knowing the schema's vocabulary.
 */
function describeAction(row: AdminAuditRow): string {
  const app = typeof row.details.appSlug === "string" ? row.details.appSlug : null;
  const role = typeof row.details.role === "string" ? row.details.role : null;
  switch (row.action) {
    case "user.create":
      return "Account created";
    case "user.grant.add":
      return app ? `Granted access to ${app}` : "Granted app access";
    case "user.grant.revoke":
      return app ? `Revoked access to ${app}` : "Revoked app access";
    case "user.role.set":
      return app
        ? `Role for ${app} set to ${role ?? "none"}`
        : "App role changed";
    case "user.admin.grant":
      return "Made an administrator";
    case "user.admin.revoke":
      return "Admin access removed";
    case "user.password.set":
      return "Password reset by an admin";
    case "user.profile.update":
      return row.details.emailChanged
        ? `Email changed${
            typeof row.details.previousEmail === "string"
              ? ` from ${row.details.previousEmail}`
              : ""
          }`
        : "Profile updated";
    default:
      // An action this list has not learned yet still shows up, as itself. A
      // switch that returned "" for the default would silently drop rows.
      return row.action;
  }
}

export default function UserDialog({
  user,
  open,
  onClose,
  registeredApps,
  blockedBySlug,
  currentAdminId,
  toggleAction,
  setRoleAction,
}: {
  user: UserRow;
  open: boolean;
  onClose: () => void;
  registeredApps: AppManifest[];
  /** Slug → the connectors it needs that nobody configured, already formatted. */
  blockedBySlug: Record<string, string>;
  /** The admin doing the looking, so the page can refuse to demote them. */
  currentAdminId: string;
  toggleAction: (formData: FormData) => Promise<GrantToggleOutcome>;
  setRoleAction: (formData: FormData) => void | Promise<void>;
}) {
  const [tab, setTab] = useState<DialogTab>("profile");

  const [profileState, profileAction, profilePending] = useActionState(
    adminUpdateProfile,
    INITIAL_ACCOUNT_STATE,
  );
  const [pwState, pwAction, pwPending] = useActionState(
    adminSetPassword,
    INITIAL_ACCOUNT_STATE,
  );
  const [adminState, adminAction, adminPending] = useActionState(
    adminSetIsAdmin,
    INITIAL_ACCOUNT_STATE,
  );

  /*
    No effect resets this on a change of user. `UserTable` renders this dialog
    with `key={user.id}`, so pointing it at a different person remounts it and
    the tab starts at "profile" on its own. An effect that re-set it would be
    the cascading render React's lint rule names, guarding against a case the
    key has already made impossible.
  */

  const isSelf = user.id === currentAdminId;

  /*
    Push a rename of YOUR OWN account into the menu bar.

    The header shows `useSession().data.user.name`, which is a client-side
    cache. The server is never stale — the `jwt` callback re-reads
    `display_name` from the row on every session resolution — but nothing tells
    the copy the header is already holding that the row moved, so the bar keeps
    showing the old name until a full reload. `update()` is what re-resolves it
    in place, and it is the same thing the /account form does after its own
    rename.

    Gated on `isSelf`: renaming somebody else must not touch your session, and
    an ungated call would fire a pointless round trip on every save. Their
    header catches up on their next session resolution, since the callback
    re-reads the row every time.
  */
  const { update: updateSession } = useSession();
  // Pinned in a ref because `useSession` returns a fresh function identity on
  // every render — as a dependency it would re-fire the effect in a loop.
  // Assigned in an effect, not during render: a render-phase ref write is a
  // side effect, and a re-render triggered elsewhere would observe it half-done.
  const updateSessionRef = useRef(updateSession);
  useEffect(() => {
    updateSessionRef.current = updateSession;
  });
  useEffect(() => {
    if (isSelf && profileState.success) updateSessionRef.current({});
  }, [isSelf, profileState]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      fixedHeight
      title={user.display_name}
      subtitle={user.email}
      icon={
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-xs font-semibold text-foreground">
          {initialsOf(user.display_name)}
        </span>
      }
      tabs={
        <div className="flex items-center justify-between gap-3">
          <FolderTabs
            items={TABS}
            active={tab}
            onChange={setTab}
            surface="card"
          />
          {user.is_admin && (
            <StatusPill tone="success">Administrator</StatusPill>
          )}
        </div>
      }
    >
      <div className="space-y-5">
        {tab === "profile" && (
          <>
            <section className="space-y-3">
              <SectionHeading>Profile</SectionHeading>
              <form action={profileAction} className="space-y-4">
                <input type="hidden" name="userId" value={user.id} />
                <Field label="Display name" required>
                  {(args) => (
                    <input
                      {...args}
                      name="displayName"
                      defaultValue={user.display_name}
                      required
                      maxLength={120}
                      className={INPUT_CLASS}
                    />
                  )}
                </Field>
                <Field
                  label="Email"
                  required
                  hint="This is how they sign in. Changing it signs them out of every device."
                >
                  {(args) => (
                    <input
                      {...args}
                      type="email"
                      name="email"
                      defaultValue={user.email}
                      required
                      autoComplete="off"
                      className={INPUT_CLASS}
                    />
                  )}
                </Field>
                <Banner state={profileState} />
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    variant="primary"
                    size="sm"
                    busy={profilePending}
                    busyLabel="Saving…"
                  >
                    Save changes
                  </Button>
                </div>
              </form>
            </section>

            {/* ── Admin access ─────────────────────────────────────────────
                Its own form, and its own submit. A checkbox folded into the
                profile form above would make "fix a typo in their name" and
                "grant them every credential in the deployment" the same
                button. */}
            <section className="space-y-3 border-t border-border pt-5">
              <SectionHeading>Admin access</SectionHeading>
              <p className="text-sm text-muted-foreground">
                Administrators can reach every admin page: user access,
                connector credentials, themes and the app registry.
              </p>
              <Banner state={adminState} />
              {isSelf ? (
                /*
                  Stated, not hidden. An admin looking for their own toggle and
                  finding nothing assumes the feature is missing; the reason is
                  one sentence and it belongs on screen. Disabled controls are
                  the one place ux.md permits dimming.
                */
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    This is your own account.
                  </p>
                  <Button size="sm" disabled aria-disabled="true">
                    Remove admin access
                  </Button>
                </div>
              ) : (
                <form action={adminAction} className="flex justify-end">
                  <input type="hidden" name="userId" value={user.id} />
                  <input
                    type="hidden"
                    name="isAdmin"
                    value={String(!user.is_admin)}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant={user.is_admin ? "secondary" : "primary"}
                    busy={adminPending}
                    busyLabel="Saving…"
                    icon={<ShieldCheck className="h-4 w-4" aria-hidden />}
                  >
                    {user.is_admin
                      ? "Remove admin access"
                      : "Make administrator"}
                  </Button>
                </form>
              )}
            </section>
          </>
        )}

        {tab === "security" && (
          <section className="space-y-3">
            <SectionHeading>Set a new password</SectionHeading>
            <p className="text-sm text-muted-foreground">
              Sets {user.display_name}&apos;s password directly — they are not
              asked for their old one. Give them the new password over a channel
              you trust, and have them change it.
            </p>
            <form action={pwAction} className="space-y-4">
              <input type="hidden" name="userId" value={user.id} />
              <Field
                label="New password"
                required
                hint="At least 10 characters."
              >
                {(args) => (
                  <input
                    {...args}
                    type="password"
                    name="newPassword"
                    required
                    minLength={10}
                    autoComplete="new-password"
                    className={INPUT_CLASS}
                  />
                )}
              </Field>
              <Field label="Confirm new password" required>
                {(args) => (
                  <input
                    {...args}
                    type="password"
                    name="confirmPassword"
                    required
                    minLength={10}
                    autoComplete="new-password"
                    className={INPUT_CLASS}
                  />
                )}
              </Field>
              <Field
                label="Your own password"
                required
                hint="Confirms it is you taking over this account, not someone at your unlocked laptop."
              >
                {(args) => (
                  <input
                    {...args}
                    type="password"
                    name="actorPassword"
                    required
                    autoComplete="current-password"
                    className={INPUT_CLASS}
                  />
                )}
              </Field>

              <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground">
                This signs {user.display_name} out of every device they are
                currently using.
              </p>

              <Banner state={pwState} />

              <div className="flex justify-end">
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  busy={pwPending}
                  busyLabel="Setting…"
                >
                  Set password
                </Button>
              </div>
            </form>
          </section>
        )}

        {tab === "access" && (
          <AppAccessPanel
            user={user}
            registeredApps={registeredApps}
            blockedBySlug={blockedBySlug}
            toggleAction={toggleAction}
            setRoleAction={setRoleAction}
          />
        )}

        {tab === "activity" && (
          <ActivityPanel key={user.id} userId={user.id} />
        )}
      </div>
    </Dialog>
  );
}

/** "Ada Lovelace" → "AL". Falls back to one letter, or a person glyph. */
function initialsOf(name: string): ReactNode {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return letters || <UserIcon className="h-4 w-4" aria-hidden />;
}

/**
 * Grants and per-app roles — the tab this page originally existed for.
 *
 * Moved wholesale out of the accordion it used to live in. The controls, the
 * connector gate and its wording are unchanged: what changed is that it is now
 * one tab of a record rather than the only thing the page could show.
 * Exported for its test, which renders it on its own.
 */
export function AppAccessPanel({
  user,
  registeredApps,
  blockedBySlug,
  toggleAction,
  setRoleAction,
}: {
  user: UserRow;
  registeredApps: AppManifest[];
  blockedBySlug: Record<string, string>;
  toggleAction: (formData: FormData) => Promise<GrantToggleOutcome>;
  setRoleAction: (formData: FormData) => void | Promise<void>;
}) {
  const toast = useToast();

  if (registeredApps.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No apps found. Add an app to the /apps directory.
      </p>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHeading>App access</SectionHeading>
      <p className="text-sm text-muted-foreground">
        Granting lets {user.display_name} install the app from their App
        Manager. Revoking also uninstalls it.
      </p>
      <div className={cn(CARD_SHELL, "divide-y divide-border overflow-hidden")}>
        {registeredApps.map((app) => {
          const granted = user.grantedSlugs.includes(app.slug);
          const isGlobal = app.global;
          // A role can be assigned whenever the user effectively has the app
          // (explicit grant or global) and the app declares roles. Global apps
          // still show the dropdown — the grant row it writes carries only the
          // role, not access.
          const showRoles = (granted || isGlobal) && app.roles.length > 0;
          // The stored role, or "" for the app's default, which the user then
          // follows when it changes.
          const currentRole = user.assignedRoleBySlug[app.slug] ?? "";
          /*
            A role kept from when the app was global: a role, not access
            (migration 0013). Granting turns it into a grant with that role,
            while the app still declares it.
          */
          const roleOnly =
            !isGlobal && !granted && Object.hasOwn(user.roleOnlyBySlug, app.slug);
          const keptRole = roleOnly ? user.roleOnlyBySlug[app.slug] : null;
          const keptLabel = app.roles.find((r) => r.key === keptRole)?.label ?? null;
          /*
            Granting is blocked while a connector this app requires isn't
            ready: not configured, not connected, or disabled. The app would be
            broken for whoever receives it. Revoking is never blocked: an app
            that stopped working is exactly the one you want to be able to take
            away.
          */
          const blockedBy = blockedBySlug[app.slug];
          const blockGrant = !granted && blockedBy != null;
          return (
            <div
              key={app.slug}
              className="flex items-start justify-between gap-4 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{app.name}</p>
                <p className="break-words text-sm text-muted-foreground">
                  {app.description}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                {isGlobal ? (
                  <div className="flex flex-col items-end">
                    <button
                      type="button"
                      disabled
                      aria-disabled="true"
                      className="cursor-not-allowed rounded-full bg-brand/70 px-4 py-1.5 text-sm font-medium text-brand-foreground opacity-90"
                    >
                      Granted
                    </button>
                    <span className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      Global App
                    </span>
                  </div>
                ) : (
                  <form
                    action={async (formData) => {
                      const outcome = await toggleAction(formData);
                      // The page was out of date: someone else had already
                      // made this change. Nothing was written.
                      if (!outcome.changed) {
                        toast.show(
                          "warning",
                          granted
                            ? `${user.display_name} didn't have ${app.name}, so there was nothing to revoke.`
                            : `${user.display_name} already had ${app.name}. Their role wasn't changed.`,
                        );
                      }
                    }}
                    className="flex flex-col items-end"
                  >
                    <input type="hidden" name="userId" value={user.id} />
                    <input type="hidden" name="slug" value={app.slug} />
                    <input type="hidden" name="granted" value={String(granted)} />
                    {keptRole && keptLabel && (
                      <input type="hidden" name="role" value={keptRole} />
                    )}
                    <button
                      type="submit"
                      disabled={blockGrant}
                      aria-disabled={blockGrant}
                      title={blockGrant ? `${blockedBy} first` : undefined}
                      /*
                        Disabled is signalled by a dashed border and the cursor,
                        NOT by dimming. WCAG exempts inactive controls, but the
                        label under this button has to stay readable to be worth
                        printing — and `opacity-50` on `text-muted-foreground`
                        lands at 1.96:1, which the contrast rule rejects
                        outright. See docs/apps/ux.md#never-dim-a-token.
                      */
                      className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                        granted
                          ? "bg-brand text-brand-foreground hover:bg-brand/80"
                          : blockGrant
                            ? "cursor-not-allowed border border-dashed border-border bg-background text-muted-foreground"
                            : "border border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                      }`}
                    >
                      {granted ? "Granted" : "Not Granted"}
                    </button>
                    {/* The reason, in text. A dimmed button that explains itself
                        only on hover explains itself to nobody on a touch
                        screen. */}
                    {blockGrant && (
                      <span className="mt-1 max-w-[16rem] text-right text-[10px] leading-tight text-muted-foreground">
                        {blockedBy} first
                      </span>
                    )}
                    {roleOnly && (
                      <span className="mt-1 max-w-[16rem] text-right text-[10px] leading-tight text-muted-foreground">
                        {keptLabel
                          ? `${keptLabel} role kept from when it was global, with no access. Granting keeps the role.`
                          : "A role kept from when it was global, with no access. Granting gives the default role."}
                      </span>
                    )}
                  </form>
                )}
                {showRoles && (
                  <RoleSelect
                    userId={user.id}
                    slug={app.slug}
                    appName={app.name}
                    userName={user.display_name}
                    roles={app.roles}
                    defaultRole={app.defaultRole}
                    current={currentRole}
                    action={setRoleAction}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** One person's role in one app. Exported for its test. */
export function RoleSelect({
  userId,
  slug,
  appName,
  userName,
  roles,
  defaultRole,
  current,
  action,
}: {
  userId: string;
  slug: string;
  appName: string;
  userName: string;
  roles: AppRole[];
  /** The manifest's defaultRole: what "Default" means today. */
  defaultRole: string | null;
  /** The stored role, or "" for none: the user follows the default. */
  current: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  // Controlled + optimistic: the value lives in local state so it never flips
  // back to a stale prop while the server action + revalidation are in flight.
  const [value, setValue] = useState(current);
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  // "Default" stores no role, so the user follows the manifest's defaultRole,
  // and changes with it. Named with what it is today.
  const roleLabel = (key: string) => roles.find((r) => r.key === key)?.label ?? key;
  const defaultLabel = `Default (${defaultRole ? roleLabel(defaultRole) : "no role"})`;
  const labelOf = (key: string) => (key === "" ? defaultLabel : roleLabel(key));
  // A stored role the app no longer declares satisfies no route. Shown, so the
  // select doesn't claim a role the person doesn't have, and not offered.
  const stale = value !== "" && !roles.some((r) => r.key === value);

  function handleChange(e: ChangeEvent<HTMLSelectElement>) {
    const next = e.target.value;
    const prev = value;
    if (next === prev) return;
    setValue(next);
    const fd = new FormData();
    fd.set("userId", userId);
    fd.set("slug", slug);
    fd.set("role", next);
    startTransition(async () => {
      try {
        await action(fd);
        toast.show(
          "success",
          `${userName}'s role for ${appName} changed from ${labelOf(prev)} to ${labelOf(next)}.`,
        );
      } catch {
        // Revert the optimistic value so the dropdown reflects reality.
        setValue(prev);
        toast.show(
          "error",
          `Couldn't change ${userName}'s role for ${appName}. Please try again.`,
        );
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <label className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Role
      </label>
      <select
        value={value}
        onChange={handleChange}
        disabled={pending}
        className="rounded-md border border-input bg-background px-2 py-1 text-xs disabled:opacity-60"
      >
        <option value="">{defaultLabel}</option>
        {stale && (
          <option value={value} disabled>
            {value} (no longer declared)
          </option>
        )}
        {roles.map((role) => (
          <option key={role.key} value={role.key}>
            {role.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Everything done to this account, most recent first.
 *
 * Fetched when the tab is first opened rather than with the page. The users
 * page already fans out four queries to build the table; an audit read per row
 * would multiply that by the user count to fill a tab most opens never reach.
 */
function ActivityPanel({ userId }: { userId: string }) {
  const [rows, setRows] = useState<AdminAuditRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    getUserActivity(userId)
      .then((r) => {
        if (live) setRows(r);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    /*
      Cancelled on unmount, so a slow response cannot land after this panel is
      gone. There is deliberately no `setRows(null)` at the top of the effect to
      clear the previous user's rows — a synchronous setState in an effect body
      is the cascading render the lint rule rejects. The call site keys this
      component by `userId`, which achieves the same reset by remounting.
    */
    return () => {
      live = false;
    };
  }, [userId]);

  if (failed) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        Could not load this user&apos;s history.
      </p>
    );
  }
  if (rows === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (rows.length === 0) {
    return (
      <section className="space-y-3">
        <SectionHeading>History</SectionHeading>
        <p className="text-sm text-muted-foreground">
          Nothing recorded yet. Grants, role changes and password resets show up
          here once an admin makes one.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHeading>History</SectionHeading>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-1.5 pr-3 font-semibold">
                When
              </th>
              <th scope="col" className="py-1.5 pr-3 font-semibold">
                What
              </th>
              <th scope="col" className="py-1.5 font-semibold">
                By
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.id} className="align-top">
                <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                  <AuditTime at={row.createdAt} />
                </td>
                <td className="py-1.5 pr-3 text-foreground">
                  {describeAction(row)}
                </td>
                <td className="py-1.5 text-muted-foreground">
                  {row.actorEmail}
                  {!row.actorVerified && (
                    <span
                      className="ml-1 text-xs"
                      title="Written without a sign-in, so nothing checked who it names."
                    >
                      (unverified)
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * A timestamp in the reader's own zone.
 *
 * These rows only ever arrive after mount, so there is no server pass to
 * mismatch — but the formatting still depends on the reader's locale, and doing
 * it inline keeps that fact next to the only place it applies.
 */
function AuditTime({ at }: { at: string }) {
  const when = new Date(at);
  return (
    <time dateTime={when.toISOString()} title={when.toLocaleString()}>
      {when.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}
    </time>
  );
}
