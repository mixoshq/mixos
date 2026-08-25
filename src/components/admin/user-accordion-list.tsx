"use client";

import {
  useCallback,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
} from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { AppManifest, AppRole } from "@/lib/apps/types";

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
}

interface Props {
  users: UserRow[];
  registeredApps: AppManifest[];
  toggleAction: (formData: FormData) => void | Promise<void>;
  setRoleAction: (formData: FormData) => void | Promise<void>;
}

interface Toast {
  id: number;
  kind: "success" | "error";
  message: string;
}

export default function UserAccordionList({
  users,
  registeredApps,
  toggleAction,
  setRoleAction,
}: Props) {
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (t: { kind: "success" | "error"; message: string }) => {
      const id = (toastSeq.current += 1);
      setToasts((prev) => [...prev, { id, ...t }]);
      setTimeout(() => dismissToast(id), 5000);
    },
    [dismissToast],
  );

  if (users.length === 0) {
    return (
      <div className="px-6 py-8 text-center text-muted-foreground">
        No users have logged in yet.
      </div>
    );
  }

  return (
    <>
      <div className="divide-y divide-border">
      {users.map((user) => {
        const open = openUserId === user.id;
        return (
          <div key={user.id}>
            <button
              type="button"
              onClick={() => setOpenUserId(open ? null : user.id)}
              aria-expanded={open}
              className="flex w-full items-center justify-between px-6 py-4 text-left transition-colors hover:bg-accent"
            >
              <div className="flex min-w-0 items-center gap-3">
                {open ? (
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0">
                  <p className="truncate font-medium">{user.display_name}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {user.email}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className="rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
                  title="Apps installed by this user of those granted and currently active in the registry"
                >
                  {user.grantedActiveCount}{" "}
                  {user.grantedActiveCount === 1 ? "app" : "apps"} granted,{" "}
                  {user.installedActiveCount} installed
                </span>
                {user.is_admin && (
                  <span className="rounded-full bg-mixnavy px-2.5 py-0.5 text-xs font-medium text-white">
                    Admin
                  </span>
                )}
              </div>
            </button>

            {open && (
              <div className="border-t border-border bg-muted/30 px-6 py-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  App Access
                </p>
                <p className="mb-3 text-xs text-muted-foreground">
                  Granting lets the user install the app from their App
                  Manager. Revoking also uninstalls it.
                </p>
                {registeredApps.length > 0 ? (
                  <div className="divide-y divide-border rounded-lg border border-border bg-card">
                    {registeredApps.map((app) => {
                      const granted = user.grantedSlugs.includes(app.slug);
                      const isGlobal = app.global;
                      // A role can be assigned whenever the user effectively has
                      // the app (explicit grant or global) and the app declares
                      // roles. Global apps still show the dropdown — the grant
                      // row it writes only carries the role, not access.
                      const showRoles =
                        (granted || isGlobal) && app.roles.length > 0;
                      const currentRole = user.roleBySlug[app.slug] ?? "";
                      return (
                        <div
                          key={app.slug}
                          className="flex items-start justify-between gap-4 px-4 py-3"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium">{app.name}</p>
                            <p className="text-sm text-muted-foreground break-words">
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
                                  className="cursor-not-allowed rounded-full bg-mixnavy/70 px-4 py-1.5 text-sm font-medium text-white opacity-90"
                                >
                                  Granted
                                </button>
                                <span className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                                  Global App
                                </span>
                              </div>
                            ) : (
                              <form action={toggleAction}>
                                <input type="hidden" name="userId" value={user.id} />
                                <input type="hidden" name="slug" value={app.slug} />
                                <input
                                  type="hidden"
                                  name="granted"
                                  value={String(granted)}
                                />
                                <button
                                  type="submit"
                                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                                    granted
                                      ? "bg-mixnavy text-white hover:bg-mixnavy/80"
                                      : "border border-border bg-background text-muted-foreground hover:bg-accent"
                                  }`}
                                >
                                  {granted ? "Granted" : "Not Granted"}
                                </button>
                              </form>
                            )}
                            {showRoles && (
                              <RoleSelect
                                userId={user.id}
                                slug={app.slug}
                                appName={app.name}
                                userName={user.display_name}
                                roles={app.roles}
                                current={currentRole}
                                action={setRoleAction}
                                onToast={pushToast}
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No apps registered. Register apps in the App Registry first.
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
      </div>

      {toasts.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              className={`pointer-events-auto flex max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg ${
                t.kind === "error"
                  ? "border-red-300 bg-red-50 text-red-800"
                  : "border-border bg-card text-foreground"
              }`}
            >
              <span className="flex-1">{t.message}</span>
              <button
                type="button"
                onClick={() => dismissToast(t.id)}
                aria-label="Dismiss"
                className="-mr-1 -mt-0.5 shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RoleSelect({
  userId,
  slug,
  appName,
  userName,
  roles,
  current,
  action,
  onToast,
}: {
  userId: string;
  slug: string;
  appName: string;
  userName: string;
  roles: AppRole[];
  current: string;
  action: (formData: FormData) => void | Promise<void>;
  onToast: (t: { kind: "success" | "error"; message: string }) => void;
}) {
  // Controlled + optimistic: the value lives in local state so it never flips
  // back to a stale prop while the server action + revalidation are in flight.
  const [value, setValue] = useState(current);
  const [pending, startTransition] = useTransition();

  const labelOf = (key: string) =>
    roles.find((r) => r.key === key)?.label ?? (key || "None");

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
        onToast({
          kind: "success",
          message: `${userName}'s role for ${appName} changed from ${labelOf(prev)} to ${labelOf(next)}.`,
        });
      } catch {
        // Revert the optimistic value so the dropdown reflects reality.
        setValue(prev);
        onToast({
          kind: "error",
          message: `Couldn't change ${userName}'s role for ${appName}. Please try again.`,
        });
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
        className="rounded-md border border-border bg-background px-2 py-1 text-xs disabled:opacity-60"
      >
        {roles.map((role) => (
          <option key={role.key} value={role.key}>
            {role.label}
          </option>
        ))}
      </select>
    </div>
  );
}
