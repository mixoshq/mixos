/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useMemo, useState } from "react";
import { X, Search, LayoutGrid, Layers } from "lucide-react";
import type { AppManifest, WidgetDefinition } from "@/lib/apps/types";
import type { DashboardWidget, LayoutItem } from "@/lib/dashboard/actions";
import { addWidget } from "@/lib/dashboard/actions";
import WidgetConfigModal from "./widget-config-modal";
import LucideIcon from "@/components/lucide-icon";
import { CARD_SURFACE } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface WidgetCatalogProps {
  apps: AppManifest[];
  onClose: () => void;
  onWidgetAdded: (widget: DashboardWidget, layoutItem: LayoutItem) => void;
}

type FlatWidget = {
  app: AppManifest;
  widget: WidgetDefinition;
};

export default function WidgetCatalog({
  apps,
  onClose,
  onWidgetAdded,
}: WidgetCatalogProps) {
  const [configuring, setConfiguring] = useState<{
    app: AppManifest;
    widget: WidgetDefinition;
  } | null>(null);
  const [search, setSearch] = useState("");
  const [grouped, setGrouped] = useState(false);

  const appsWithWidgets = useMemo(
    () => apps.filter((a) => a.widgets.length > 0),
    [apps],
  );

  // Flat list of all widgets with their parent app
  const allWidgets: FlatWidget[] = useMemo(
    () =>
      appsWithWidgets.flatMap((app) =>
        app.widgets.map((widget) => ({ app, widget })),
      ),
    [appsWithWidgets],
  );

  // Filter by search
  const filtered = useMemo(() => {
    if (!search.trim()) return allWidgets;
    const q = search.toLowerCase();
    return allWidgets.filter(
      ({ app, widget }) =>
        widget.name.toLowerCase().includes(q) ||
        widget.description.toLowerCase().includes(q) ||
        app.name.toLowerCase().includes(q),
    );
  }, [allWidgets, search]);

  // Group by app (for grouped view)
  const groupedByApp = useMemo(() => {
    const map = new Map<string, { app: AppManifest; widgets: FlatWidget[] }>();
    for (const fw of filtered) {
      const existing = map.get(fw.app.slug);
      if (existing) {
        existing.widgets.push(fw);
      } else {
        map.set(fw.app.slug, { app: fw.app, widgets: [fw] });
      }
    }
    return [...map.values()];
  }, [filtered]);

  const handleSelectWidget = (app: AppManifest, widget: WidgetDefinition) => {
    if (widget.config && widget.config.length > 0) {
      setConfiguring({ app, widget });
    } else {
      handleAddWidget(app.slug, widget, {});
    }
  };

  const handleAddWidget = async (
    appSlug: string,
    widget: WidgetDefinition,
    config: Record<string, unknown>,
  ) => {
    const layoutItem: LayoutItem = {
      i: "temp",
      x: 0,
      y: Infinity,
      w: widget.defaultSize?.w ?? 4,
      h: widget.defaultSize?.h ?? 3,
      minW: widget.minSize?.w,
      minH: widget.minSize?.h,
    };

    const instanceId = await addWidget(appSlug, widget.id, config, layoutItem);
    onWidgetAdded(
      { id: instanceId, app_slug: appSlug, widget_id: widget.id, config },
      { ...layoutItem, i: instanceId },
    );
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        <div
          className={cn(
            "mix-modal",
            CARD_SURFACE,
            "mx-4 w-full max-w-5xl shadow-xl",
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between rounded-t-xl bg-brand px-6 py-4">
            <h2 className="text-lg font-semibold text-white">Add Widget</h2>
            <div className="flex items-center gap-2">
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-white/50" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search widgets…"
                  className="h-8 w-56 rounded-lg border border-white/20 bg-white/10 pl-8 pr-3 text-sm text-white placeholder:text-white/40 outline-none focus:ring-2 focus:ring-white/40"
                />
              </div>
              {/* Group toggle */}
              <button
                onClick={() => setGrouped(!grouped)}
                className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                  grouped
                    ? "border-white/40 bg-white/20 text-white"
                    : "border-white/20 text-white/70 hover:bg-white/10 hover:text-white"
                }`}
                title={grouped ? "Show all widgets" : "Group by app"}
              >
                {grouped ? (
                  <Layers className="h-3.5 w-3.5" />
                ) : (
                  <LayoutGrid className="h-3.5 w-3.5" />
                )}
                {grouped ? "Grouped" : "Group by App"}
              </button>
              {/* Close */}
              <button
                onClick={onClose}
                className="text-white/70 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="max-h-[60vh] overflow-auto p-6">
            {filtered.length === 0 ? (
              <p className="py-8 text-center text-muted-foreground">
                {search
                  ? "No widgets match your search."
                  : "No widgets available. Enable apps that provide widgets."}
              </p>
            ) : grouped ? (
              // ── Grouped view ──────────────────────────────────────
              <div className="space-y-6">
                {groupedByApp.map(({ app, widgets }) => (
                  <div key={app.slug}>
                    <div className="mb-3 flex items-center gap-2">
                      <LucideIcon
                        name={app.icon}
                        className="h-4 w-4 text-muted-foreground"
                      />
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                        {app.name}
                      </h3>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {widgets.map(({ widget }) => (
                        <WidgetCard
                          key={`${app.slug}:${widget.id}`}
                          app={app}
                          widget={widget}
                          showApp={false}
                          onSelect={() => handleSelectWidget(app, widget)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              // ── Flat view ─────────────────────────────────────────
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map(({ app, widget }) => (
                  <WidgetCard
                    key={`${app.slug}:${widget.id}`}
                    app={app}
                    widget={widget}
                    showApp
                    onSelect={() => handleSelectWidget(app, widget)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {configuring && (
        <WidgetConfigModal
          appSlug={configuring.app.slug}
          widget={configuring.widget}
          onClose={() => setConfiguring(null)}
          onSave={(config) =>
            handleAddWidget(configuring.app.slug, configuring.widget, config)
          }
        />
      )}
    </>
  );
}

// ── WidgetCard ──────────────────────────────────────────────────────────

function WidgetCard({
  app,
  widget,
  showApp,
  onSelect,
}: {
  app: AppManifest;
  widget: WidgetDefinition;
  showApp: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      data-tour={`widget-${app.slug}`}
      className="flex flex-col gap-3 rounded-lg border border-border p-4"
    >
      <div className="flex items-start gap-3">
        <LucideIcon
          name={app.icon}
          className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{widget.name}</p>
          {showApp && (
            <p className="text-xs text-muted-foreground">{app.name}</p>
          )}
          <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
            {widget.description}
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onSelect}
        className="self-end rounded-full bg-brand px-3 py-1.5 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand/85"
      >
        Add to Dashboard
      </button>
    </div>
  );
}
