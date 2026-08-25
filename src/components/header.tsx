"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { useState, useRef, useEffect } from "react";
import {
  Settings,
  ChevronDown,
  Users,
  AppWindow,
  Plug,
  Clock,
  BarChart3,
  UserCog,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  ShieldCheck,
  Pencil,
} from "lucide-react";
import AppsDropdown from "@/components/apps/apps-dropdown";
import { useDashboardEdit } from "@/components/dashboard/edit-mode-context";

/**
 * `isLocal` comes from the request Host (see src/lib/env/local-host.ts) and
 * repaints the bar bold blue — the only saturated colour in an otherwise
 * neutral UI — so a local tab is obvious at a glance. Only
 * the band and the "MixOS" wordmark change — everything else keeps its
 * production treatment, which stays legible on the darker ground.
 */
export default function Header({ isLocal = false }: { isLocal?: boolean }) {
  const { data: session, status } = useSession();
  const user = session?.user;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { setIsEditing } = useDashboardEdit();
  const router = useRouter();
  const pathname = usePathname();
  const [dashMenu, setDashMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const dashMenuRef = useRef<HTMLDivElement>(null);

  const isAdmin = user?.isAdmin === true;

  // Enter dashboard edit mode from the nav menu. If we're already on the
  // dashboard ("/") just flip editing on; otherwise navigate there first —
  // the edit-mode provider clears isEditing on any non-"/" path, so we set it
  // true after the push so it survives once the route settles on "/".
  function handleEditDashboard() {
    setMenuOpen(false);
    setDashMenu(null);
    if (pathname !== "/") router.push("/");
    setIsEditing(true);
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("mix:settings-menu-toggled", {
        detail: { open: menuOpen },
      }),
    );
  }, [menuOpen]);

  // Dismiss the Dashboard right-click menu on outside click, Escape, or scroll.
  useEffect(() => {
    if (!dashMenu) return;
    const close = () => setDashMenu(null);
    // Ignore mousedowns inside the menu — closing on a menu-item's own
    // mousedown would unmount it before its click fires, so it never activates.
    const onDown = (e: MouseEvent) => {
      if (dashMenuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [dashMenu]);

  return (
    <header
      className={`flex h-10 shrink-0 items-center justify-between border-b border-border px-4 ${
        isLocal ? "bg-mixlocal" : "bg-mixcharcoal"
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-4">
        {/* Stacked so the LOCAL caption can sit under the wordmark. The bar is
            only h-10, so both lines run leading-none to fit. */}
        <Link
          href="/"
          className="flex shrink-0 flex-col justify-center gap-0.5 leading-none"
        >
          <span className="flex items-center gap-2">
            <span
              className={`text-lg font-bold leading-none ${
                isLocal ? "text-mixlocal-mark" : "text-white"
              }`}
            >
              MONTALBANO
            </span>
            <span
              className={`text-sm leading-none ${
                isLocal ? "text-mixlocal-mark" : "text-white/70"
              }`}
            >
              OS
            </span>
          </span>
          {isLocal && (
            <span className="text-[9px] font-semibold uppercase leading-none tracking-[0.3em] text-mixlocal-mark">
              local
            </span>
          )}
        </Link>

        <Link
          href="/"
          title="Dashboard"
          data-tour="dashboard-link"
          onContextMenu={(e) => {
            e.preventDefault();
            setDashMenu({ x: e.clientX, y: e.clientY });
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          <LayoutDashboard className="h-4 w-4" />
          <span className="text-sm font-medium">Dashboard</span>
        </Link>

        <AppsDropdown />
      </div>

      <div className="flex shrink-0 items-center gap-2">
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          data-tour="settings-menu"
          className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-white/80 transition-colors hover:bg-white/10 hover:text-white"
        >
          {status === "authenticated" && user && (
            <span className="hidden text-sm text-white/70 sm:inline">
              {user.name}
            </span>
          )}
          <Settings className="h-4 w-4" />
          <ChevronDown className="h-3 w-3" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border border-border bg-card py-1 shadow-lg">
            {isAdmin && (
              <>
                <p className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Administration
                </p>
                <Link
                  href="/admin/users"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent"
                >
                  <Users className="h-4 w-4 text-muted-foreground" />
                  User Management
                </Link>
                <Link
                  href="/admin/authentication"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent"
                >
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  Authentication
                </Link>
                <Link
                  href="/admin/apps"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent"
                >
                  <AppWindow className="h-4 w-4 text-muted-foreground" />
                  App Registry
                </Link>
                <Link
                  href="/admin/connectors"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent"
                >
                  <Plug className="h-4 w-4 text-muted-foreground" />
                  Connector Registry
                </Link>
                <Link
                  href="/admin/scheduled-jobs"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent"
                >
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  Scheduled Jobs
                </Link>
                <Link
                  href="/admin/analytics"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent"
                >
                  <BarChart3 className="h-4 w-4 text-muted-foreground" />
                  Analytics
                </Link>
                <div className="my-1 border-t border-border" />
              </>
            )}
            <button
              onClick={handleEditDashboard}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
            >
              <Pencil className="h-4 w-4 text-muted-foreground" />
              Edit Dashboard
            </button>
            <Link
              href="/apps"
              onClick={() => setMenuOpen(false)}
              data-tour="app-manager-link"
              className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent"
            >
              <LayoutGrid className="h-4 w-4 text-muted-foreground" />
              App Manager
            </Link>
            <Link
              href="/account"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent"
            >
              <UserCog className="h-4 w-4 text-muted-foreground" />
              My Account
            </Link>
            <button
              onClick={() => {
                setMenuOpen(false);
                signOut({ callbackUrl: "/login" });
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive hover:bg-accent"
            >
              <LogOut className="h-4 w-4" />
              Sign Out
            </button>
          </div>
        )}
      </div>
      </div>

      {dashMenu && (
        <div
          ref={dashMenuRef}
          role="menu"
          className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-card py-1 shadow-lg"
          style={{ top: dashMenu.y, left: dashMenu.x }}
        >
          <button
            role="menuitem"
            onClick={handleEditDashboard}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
          >
            <Pencil className="h-4 w-4 text-muted-foreground" />
            Edit Dashboard
          </button>
        </div>
      )}
    </header>
  );
}
