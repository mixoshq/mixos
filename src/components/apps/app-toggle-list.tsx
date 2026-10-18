/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import type { AppManifest } from "@/lib/apps/types";
import { toggleMyAppInstall } from "@/lib/apps/actions";
import LucideIcon from "@/components/lucide-icon";
import { Toggle } from "@/components/ui/toggle";
import { renderAuthors, formatLastUpdated } from "@/lib/apps/display";

interface AppToggleListProps {
  app: AppManifest;
  installed: boolean;
}

export default function AppToggleList({ app, installed }: AppToggleListProps) {
  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);
  const router = useRouter();

  function handleToggle() {
    setActionError(null);
    startTransition(async () => {
      try {
        await toggleMyAppInstall(app.slug, installed);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Action failed");
        return;
      }
      // Notify client-only consumers (e.g. AppsDropdown in the header)
      // that the installed-app set has changed. revalidatePath alone only
      // refreshes server-rendered pages.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("apps:installed-changed"));
      }
      router.refresh();
    });
  }

  return (
    <div>
      <div className="flex items-start justify-between px-6 py-4">
        <div className="flex items-start gap-3">
          <LucideIcon name={app.icon} className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium">{app.name}</p>
            <p className="text-sm text-muted-foreground">{app.description}</p>
            <div className="mt-1 flex items-center gap-2">
              {app.hasPages && (
                <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                  Full App
                </span>
              )}
              {app.widgets.length > 0 && (
                <span className="rounded-full bg-cat-2 px-2 py-0.5 text-xs font-medium text-background">
                  {app.widgets.length} {app.widgets.length === 1 ? "Widget" : "Widgets"}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-3">
          <p className="text-[10px] leading-none text-muted-foreground">
            <strong className="font-semibold">Updated</strong>{" "}
            {formatLastUpdated(app.lastUpdated, "Not yet committed")}
          </p>
          <Toggle
            checked={installed}
            onCheckedChange={handleToggle}
            label={app.name}
            busy={isPending}
          />
          {app.authors && app.authors.length > 0 && (
            <p className="text-[10px] leading-none text-muted-foreground">
              <strong className="font-semibold">Authored By</strong>{" "}
              {renderAuthors(app.authors)}
            </p>
          )}
        </div>
      </div>

      {actionError && (
        <div className="bg-destructive/10 px-6 py-2.5">
          <p className="flex items-start gap-2 text-xs text-foreground">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{actionError}</span>
          </p>
        </div>
      )}
    </div>
  );
}
