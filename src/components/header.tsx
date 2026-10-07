/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ADMIN_SECTIONS } from "@/lib/admin/sections";
import { useSession, signOut } from "next-auth/react";
import { useState, useRef, useEffect } from "react";
import {
  Settings,
  ChevronDown,
  UserCog,
  Gauge,
  LogOut,
  Pencil,
} from "lucide-react";
import AppsDropdown from "@/components/apps/apps-dropdown";
import { useDashboardEdit } from "@/components/dashboard/edit-mode-context";
import { CARD_SURFACE } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { fitLogo, MENU_BAR_LOGO_BOX } from "@/lib/branding/fit";
import type { BrandLogo } from "@/lib/branding/types";

export default function Header({
  logo,
  name,
}: {
  logo: BrandLogo | null;
  name: string;
}) {
  const mark = logo ? fitLogo(logo, MENU_BAR_LOGO_BOX) : null;
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
      data-tour="menu-bar"
      className="mix-menubar flex h-10 shrink-0 items-center justify-between border-b border-border bg-brand px-4">
      <div className="flex min-w-0 flex-1 items-center gap-4">
        {/*
          The bar is only h-10, so the mark and wordmark run leading-none to
          fit. The name is filterable and may be up to 40 characters, so it
          truncates rather than pushing the Dashboard link along.
        */}
        <Link
          href="/"
          data-tour="menu-bar-logo"
          className="flex min-w-0 max-w-[50%] shrink-0 items-center gap-2 leading-none"
        >
          {mark && (
            <Image
              src={mark.src}
              // Decorative: the wordmark beside it already names the product.
              alt=""
              width={mark.width}
              height={mark.height}
              priority
              // Allowed to shrink, keeping its proportions (h-auto): this link
              // is capped at half the bar, and a wide horizontal lockup that
              // could not shrink would spill over the Dashboard link on a
              // phone. At full width it renders at exactly its fitted size.
              className="h-auto min-w-0 shrink"
            />
          )}
          {/*
            `truncate` clips, and under leading-none a descender hangs below
            the box — so 3px of padding gives it room, and the negative margin
            keeps the bar's layout where it was. The sign-in wordmark carries
            the same padding scaled by 24/18, which is what keeps the welcome
            tour's flight between the two landing on the same pixel.
          */}
          <span
            title={name}
            className="-my-[3px] truncate py-[3px] font-heading text-lg font-bold leading-none text-brand-foreground"
          >
            {name}
          </span>
        </Link>

        <Link
          href="/"
          title="Dashboard"
          onContextMenu={(e) => {
            e.preventDefault();
            setDashMenu({ x: e.clientX, y: e.clientY });
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-brand-foreground transition-colors hover:bg-brand-foreground/10"
        >
          <Gauge className="h-4 w-4" />
          <span className="text-sm font-medium">Dashboard</span>
        </Link>

        <AppsDropdown />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-foreground/10"
          >
            {status === "authenticated" && user && (
              <span className="hidden text-sm text-brand-foreground/70 sm:inline">
                {user.name}
              </span>
            )}
            <Settings className="h-4 w-4" />
            <ChevronDown className="h-3 w-3" />
          </button>

          {menuOpen && (
            <div
              className={cn(
                "mix-popover",
                CARD_SURFACE,
                "absolute right-0 top-full z-50 mt-1 w-56 py-1 shadow-lg",
              )}
            >
              {isAdmin && (
                <>
                  <p className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Administration
                  </p>
                  {/* Mapped from the shared list rather than written out, so this
                    menu and the admin sidebar cannot disagree about what
                    Administration contains. See src/lib/admin/sections.ts. */}
                  {ADMIN_SECTIONS.map((section) => {
                    const Icon = section.icon;
                    return (
                      <Link
                        key={section.href}
                        href={section.href}
                        onClick={() => setMenuOpen(false)}
                        className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent"
                      >
                        <Icon
                          className="h-4 w-4 text-muted-foreground"
                          aria-hidden
                        />
                        {section.label}
                      </Link>
                    );
                  })}
                  <div className="my-1 border-t border-border" />
                </>
              )}
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
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive hover:bg-destructive hover:text-destructive-foreground"
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
          className={cn(
            "mix-popover",
            CARD_SURFACE,
            "fixed z-50 min-w-[160px] py-1 shadow-lg",
          )}
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
