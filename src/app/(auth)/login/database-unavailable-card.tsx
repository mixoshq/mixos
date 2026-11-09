/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import LoginLockup from "@/components/login-lockup";
import type { BrandLogo } from "@/lib/branding/types";

/**
 * The sign-in page's card while there is no database to sign in against
 * (src/lib/platform/sign-in-database.ts): the same frame and lockup as the
 * sign-in card, with a message where the form would be.
 *
 * The message names no setting and no cause, as the maintenance page doesn't:
 * whoever reads it isn't the operator, so it sends them to one. The server log
 * says which of the three it is.
 *
 * TRY AGAIN RENDERS THE PAGE AGAIN, which is what checks. `router.refresh()`
 * asks the server for the page, and the page asks the database: once it can
 * sign anyone in, the sign-in card replaces this one in the same commit that
 * ends the transition. While it can't, this card is still here when the
 * transition ends, and shakes as the sign-in card does on a wrong password.
 * Adjusted during render, as the sign-in card's shake is.
 */
export default function DatabaseUnavailableCard({
  logo,
  name,
}: {
  logo: BrandLogo | null;
  name: string;
}) {
  const router = useRouter();
  const [checking, startChecking] = useTransition();
  const [wasChecking, setWasChecking] = useState(checking);
  const [shaking, setShaking] = useState(false);
  if (checking !== wasChecking) {
    setWasChecking(checking);
    if (!checking) setShaking(true);
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-brand px-4">
      <div
        className={cn(
          "relative w-full max-w-sm p-8 text-center",
          shaking && "login-shake",
        )}
        onAnimationEnd={() => setShaking(false)}
      >
        <div
          aria-hidden
          className="absolute inset-0 rounded-lg border border-white/10 bg-white/5 shadow-lg backdrop-blur"
        />
        <div className="relative">
          <LoginLockup logo={logo} name={name} />
          <div className="mt-8 space-y-4">
            <div
              role="alert"
              className="rounded-md border border-destructive/60 px-3 py-3 text-sm text-brand-foreground"
            >
              <p className="font-medium">Sign-in is unavailable</p>
              <p className="mt-1 text-brand-foreground/70">
                The database isn&apos;t available. Please contact your
                administrator.
              </p>
            </div>
            <button
              type="button"
              onClick={() => startChecking(() => router.refresh())}
              disabled={checking}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-foreground px-4 py-2.5 text-sm font-medium text-brand shadow-sm transition-colors hover:bg-brand-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {checking ? "Checking…" : "Try again"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
