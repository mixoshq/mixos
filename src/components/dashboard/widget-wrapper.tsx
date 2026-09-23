/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { Suspense, lazy, useState, type ComponentType } from "react";
import { GripVertical, X, Settings } from "lucide-react";
import type { DashboardWidget } from "@/lib/dashboard/actions";
import { updateWidgetConfig } from "@/lib/dashboard/actions";
import type { WidgetDefinition } from "@/lib/apps/types";
import type { WidgetProps } from "@/lib/hooks/types";
import { widgetLoaders } from "@/generated/app-registry";
import { useDashboardEdit } from "./edit-mode-context";
import WidgetConfigModal from "./widget-config-modal";
import { CARD_SURFACE } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface WidgetWrapperProps {
  widget: DashboardWidget;
  definition: WidgetDefinition | null;
  appSlug: string;
  onRemove: () => void;
}

/**
 * Every widget's lazy wrapper, built once at module load.
 *
 * `lazy()` does not invoke its loader — it only wraps it — so this is cheap, and
 * doing it here means no component is ever created during render.
 */
const LAZY_WIDGETS: Record<
  string,
  ComponentType<WidgetProps>
> = Object.fromEntries(
  Object.entries(widgetLoaders).map(([key, loader]) => [
    key,
    lazy(loader) as unknown as ComponentType<WidgetProps>,
  ]),
);

export default function WidgetWrapper({
  widget,
  definition,
  appSlug,
  onRemove,
}: WidgetWrapperProps) {
  const { isEditing } = useDashboardEdit();
  const [configOpen, setConfigOpen] = useState(false);
  const [currentConfig, setCurrentConfig] = useState(widget.config);

  // Looked up, never created. `lazy()` runs once per widget at module load
  // (see LAZY_WIDGETS) rather than during render, which is both what React's
  // rule asks for and what stops a remount from discarding the loaded chunk.
  const WidgetComponent = definition
    ? (LAZY_WIDGETS[`${appSlug}/${definition.component}`] ?? null)
    : null;

  // Slide-in/out classes for the edit bar. Absolutely positioned so it
  // overlays the top of the widget content rather than pushing it down,
  // and translateY-driven so the slide is GPU-composited and smooth.
  // Hidden state translates 103% so subpixel rounding never leaves a sliver
  // of blue visible at the top of the widget. The content area below uses
  // `isolate` so any z-indexes inside widgets are scoped to that stacking
  // context and can never paint over this bar.
  // The entire bar is the drag handle so users can grab any part of it. Action
  // buttons (settings, remove) are excluded via a `cancel` selector in the
  // grid's dragConfig so clicks on them still fire normally.
  const barClass = `widget-drag-handle absolute inset-x-0 top-0 z-20 flex select-none items-center justify-between bg-brand px-3 py-1 transition-transform duration-300 ease-out ${
    isEditing
      ? "translate-y-0 cursor-grab active:cursor-grabbing"
      : "pointer-events-none -translate-y-[103%]"
  }`;

  if (!definition) {
    return (
      <div
        className={cn(
          "mix-widget",
          CARD_SURFACE,
          "relative flex h-full flex-col overflow-hidden",
        )}
      >
        <div className={barClass}>
          <span className="text-xs font-medium text-white/70">
            Unknown Widget
          </span>
          <button
            onClick={onRemove}
            className="widget-bar-action cursor-pointer text-white/70 hover:text-destructive"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
          Widget definition not found
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "mix-widget",
        CARD_SURFACE,
        "relative flex h-full flex-col overflow-hidden",
      )}
    >
      <div className={barClass}>
        <div className="flex items-center gap-2">
          <GripVertical className="h-3.5 w-3.5 text-white/70" />
          <span className="text-xs font-medium text-white">
            {definition.name}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {definition.config && definition.config.length > 0 && (
            <button
              onClick={() => setConfigOpen(true)}
              title="Configure"
              className="widget-bar-action cursor-pointer rounded p-0.5 text-white/70 hover:bg-white/10 hover:text-white"
            >
              <Settings className="h-3 w-3" />
            </button>
          )}
          <button
            onClick={onRemove}
            className="widget-bar-action cursor-pointer rounded p-0.5 text-white/70 hover:bg-white/10 hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>
      <div className="isolate flex-1 overflow-auto p-3">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading...
            </div>
          }
        >
          {WidgetComponent && (
            <WidgetComponent
              appSlug={appSlug}
              config={currentConfig}
              size={{ w: 4, h: 3 }}
            />
          )}
        </Suspense>
      </div>
      {configOpen && (
        <WidgetConfigModal
          appSlug={appSlug}
          widget={definition}
          initialConfig={currentConfig}
          submitLabel="Save"
          onClose={() => setConfigOpen(false)}
          onSave={async (next) => {
            setCurrentConfig(next);
            setConfigOpen(false);
            await updateWidgetConfig(widget.id, next);
          }}
        />
      )}
    </div>
  );
}
