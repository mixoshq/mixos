/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import {
  Responsive,
  useContainerWidth,
  type LayoutItem as RGLLayoutItem,
  type Layout as RGLLayout,
} from "react-grid-layout";
import { Plus, Pencil, Settings } from "lucide-react";
import type { LayoutItem, DashboardWidget } from "@/lib/dashboard/actions";
import { saveLayout, removeWidget } from "@/lib/dashboard/actions";
import type { AppManifest, WidgetDefinition } from "@/lib/apps/types";
import WidgetWrapper, { isConfigurable } from "./widget-wrapper";
import WidgetCatalog from "./widget-catalog";
import { useDashboardEdit } from "./edit-mode-context";
import { useTour } from "@/components/onboarding/tour-context";
import { DASHBOARD_STEP } from "@/components/onboarding/steps";

import "react-grid-layout/css/styles.css";
import { ContextMenu, type MenuItem } from "@/components/ui/menu";
import { cn } from "@/lib/utils";

type Breakpoint = "lg" | "md" | "sm";

/**
 * Inside a widget, where the browser's own menu is what the user is reaching
 * for: "Open in new tab" on a link, "Paste" in a field, "Copy" on a selection.
 */
const NATIVE_MENU_TARGETS =
  'a[href], input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/**
 * Whether a right-click on a widget should be left to the browser — or to the
 * widget, if its own code already handled it.
 */
function leaveContextMenuAlone(e: React.MouseEvent): boolean {
  if (e.nativeEvent.defaultPrevented) return true;
  const target = e.target as Element;
  if (target.closest(NATIVE_MENU_TARGETS)) return true;
  const selection = window.getSelection();
  return (
    !!selection && !selection.isCollapsed && selection.containsNode(target, true)
  );
}

interface DashboardGridProps {
  initialLayout: LayoutItem[];
  widgets: DashboardWidget[];
  availableApps: AppManifest[];
}

export default function DashboardGrid({
  initialLayout,
  widgets,
  availableApps,
}: DashboardGridProps) {
  const [layout, setLayout] = useState<LayoutItem[]>(initialLayout);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [widgetList, setWidgetList] = useState<DashboardWidget[]>(widgets);
  const { width, containerRef } = useContainerWidth();
  const { isEditing, setIsEditing } = useDashboardEdit();
  // The welcome tour points at "Add Widgets" and then waits for the user to
  // finish editing with a widget added, so during the tour entering edit
  // mode opens the catalog straight away — as it does for an empty dashboard
  // anyway, where the only thing to do in edit mode is add something.
  const { phase: tourPhase, guideStep } = useTour();
  const tourActive = tourPhase === "guide";
  // The tour talks about the menu bar and App Manager before it talks about
  // the dashboard. Until it gets there, an empty dashboard shows nothing at all — "Your
  // dashboard is empty" and its button would be competing with the bubble
  // for the eye, and the button is the very thing that step asks for.
  const emptyStateHidden = tourPhase !== "done" && guideStep < DASHBOARD_STEP;
  const currentBreakpointRef = useRef<Breakpoint>("lg");
  const [isDraggingWidget, setIsDraggingWidget] = useState(false);
  const [isCollapsing, setIsCollapsing] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  // `widgetId` is set when the menu was opened on a widget rather than on
  // empty dashboard space.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    widgetId?: string;
  } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  // The widget whose config modal is open. Held here rather than in each
  // widget so the right-click menu can open it as well as the edit bar's gear.
  const [configuringId, setConfiguringId] = useState<string | null>(null);

  const handleBreakpointChange = useCallback((newBreakpoint: Breakpoint) => {
    currentBreakpointRef.current = newBreakpoint;
  }, []);

  // Fade the pencil out after 20s of no cursor motion on the dashboard; any
  // mouse movement re-shows it and resets the timer.
  //
  // Visibility is DERIVED from which arming generation last timed out, rather
  // than reset by a synchronous setState in the effect body. Changing edit mode
  // or the widget count changes the generation, which makes the pencil visible
  // again without the effect having to write state on the way in.
  const armKey = `${isEditing}:${widgetList.length}`;
  const [idleSince, setIdleSince] = useState<string | null>(null);
  const pencilVisible =
    isEditing || widgetList.length === 0 || idleSince !== armKey;

  useEffect(() => {
    if (isEditing || widgetList.length === 0) return;
    const el = containerRef.current;
    if (!el) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleHide = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setIdleSince(armKey), 20_000);
    };
    const onMove = () => {
      setIdleSince(null);
      scheduleHide();
    };

    scheduleHide();
    el.addEventListener("mousemove", onMove);
    return () => {
      el.removeEventListener("mousemove", onMove);
      if (timer) clearTimeout(timer);
    };
  }, [isEditing, widgetList.length, containerRef, armKey]);

  // Empty dashboard space. Widgets have their own handler (below), and the
  // event bubbles here after it, so a right-click on one is left alone.
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isEditing) return;
      if ((e.target as HTMLElement).closest(".react-grid-item")) return;
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY });
    },
    [isEditing],
  );

  // In edit mode the edit bar already offers Configure, and "Edit Dashboard"
  // means nothing, so the browser keeps its menu there.
  const handleWidgetContextMenu = useCallback(
    (e: React.MouseEvent, widgetId: string) => {
      if (isEditing || leaveContextMenuAlone(e)) return;
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, widgetId });
    },
    [isEditing],
  );

  const handleLayoutChange = useCallback((newLayout: RGLLayout) => {
    // Only persist changes made at the `lg` breakpoint. Smaller breakpoints
    // render an auto-compacted view; saving those would overwrite the user's
    // real layout and fail to restore it when the browser resizes back up.
    if (currentBreakpointRef.current !== "lg") return;
    const mapped: LayoutItem[] = newLayout.map((item: RGLLayoutItem) => ({
      i: item.i,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      minW: item.minW,
      minH: item.minH,
    }));
    setLayout(mapped);
    saveLayout(mapped);
  }, []);

  const handleRemoveWidget = useCallback(async (instanceId: string) => {
    await removeWidget(instanceId);
    setWidgetList((prev) => prev.filter((w) => w.id !== instanceId));
    setLayout((prev) => prev.filter((item) => item.i !== instanceId));
  }, []);

  // Click the pencil → mount the pill but immediately animate it FROM the
  // pencil's slot TO its natural centered position. Mirror of the collapse so
  // the user sees the same shape transformation in reverse.
  const handleEnterEdit = useCallback(() => {
    if (isExpanding || isCollapsing) return;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const openCatalog = widgetList.length === 0 || tourActive;

    if (reduced) {
      setIsEditing(true);
      if (openCatalog) setCatalogOpen(true);
      return;
    }

    setIsExpanding(true);
    setIsEditing(true);
    if (openCatalog) setCatalogOpen(true);
  }, [isExpanding, isCollapsing, setIsEditing, widgetList.length, tourActive]);

  // Once the pill mounts in expand mode, measure its natural rect, then run
  // the reverse WAAPI keyframes. useLayoutEffect runs synchronously after
  // mount and before paint so the browser's first paint already has the
  // animation's first keyframe applied — no flash at full size.
  useLayoutEffect(() => {
    if (!isExpanding) return;
    const pill = pillRef.current;
    if (!pill) return;

    const rect = pill.getBoundingClientRect();
    // Round all pixel values to integers to avoid subpixel-rendering jitter.
    const startLeft = Math.round(rect.left);
    const startWidth = Math.round(rect.width);
    const startHeight = Math.round(rect.height);
    // Pencil's visual left edge: bottom-6 right-6, w-9 → vw - 24 - 36.
    const pencilLeft = Math.round(window.innerWidth - 60);

    // Animate `left` as a pixel value with `transform: none` AND
    // `translate: none`. The pill's natural CSS uses `left: 50%` +
    // `-translate-x-1/2`; in Tailwind v4 that utility writes the standalone
    // `translate` property, not `transform`, so we have to clear both or the
    // pill keeps shifting half its width left during the animation.
    const animation = pill.animate(
      [
        {
          left: `${pencilLeft}px`,
          transform: "none",
          translate: "none",
          width: "36px",
          height: "36px",
          padding: "0px",
        },
        {
          left: `${startLeft}px`,
          transform: "none",
          translate: "none",
          width: `${startWidth}px`,
          height: `${startHeight}px`,
          padding: "8px",
        },
      ],
      {
        duration: 450,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        fill: "forwards",
      },
    );

    animation.onfinish = () => {
      setIsExpanding(false);
      // cancel() drops the pixel-`left` and `transform: none` overrides;
      // CSS reasserts `left: 50%` + `translateX(-50%)`, which renders at
      // the same visual rect we just animated to (no jump).
      animation.cancel();
    };

    return () => {
      animation.cancel();
    };
  }, [isExpanding]);

  // Animate the editing pill collapsing into the pencil button's slot in the
  // bottom-right. The motion teaches the user where to find the pencil, which
  // would otherwise just appear out of nowhere (and fade out 20s later).
  const handleDoneEditing = useCallback(() => {
    if (isCollapsing || isExpanding) return;

    const pill = pillRef.current;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced || !pill) {
      setIsEditing(false);
      return;
    }

    const rect = pill.getBoundingClientRect();
    const startLeft = Math.round(rect.left);
    const startWidth = Math.round(rect.width);
    const startHeight = Math.round(rect.height);
    // Pencil's visual left edge: bottom-6 right-6, w-9 → vw - 24 - 36.
    const pencilLeft = Math.round(window.innerWidth - 60);

    setIsCollapsing(true);
    // Flip isEditing immediately so widget bars slide up concurrently with
    // the pill collapse. The pill itself is gated on `isEditing || isCollapsing`
    // so it stays mounted through the animation despite isEditing now being false.
    setIsEditing(false);

    // Pure-pixel `left` + `width` keyframes (transform: none) — see expand
    // animation above for the rationale. Avoiding the percentage transform
    // eliminates the perceived left/right wobble during interpolation.
    const animation = pill.animate(
      [
        {
          left: `${startLeft}px`,
          transform: "none",
          translate: "none",
          width: `${startWidth}px`,
          height: `${startHeight}px`,
          padding: "8px",
        },
        {
          left: `${pencilLeft}px`,
          transform: "none",
          translate: "none",
          width: "36px",
          height: "36px",
          padding: "0px",
        },
      ],
      {
        duration: 450,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        fill: "forwards",
      },
    );

    animation.onfinish = () => {
      setIsCollapsing(false);
    };
  }, [isCollapsing, isExpanding, setIsEditing]);

  const handleWidgetAdded = useCallback(
    (widget: DashboardWidget, layoutItem: LayoutItem) => {
      setWidgetList((prev) => [...prev, widget]);
      setLayout((prev) => [...prev, layoutItem]);
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("dashboard:widget-added", {
            detail: { appSlug: widget.app_slug, widgetId: widget.widget_id },
          }),
        );
      }
    },
    [],
  );

  const resolveWidgetDef = (
    appSlug: string,
    widgetId: string,
  ): { app: AppManifest; def: WidgetDefinition } | null => {
    const app = availableApps.find((a) => a.slug === appSlug);
    if (!app) return null;
    const def = app.widgets.find((w) => w.id === widgetId);
    if (!def) return null;
    return { app, def };
  };

  // Configure is left out, not disabled, for a widget with nothing to configure.
  const contextMenuItems = (widgetId?: string): MenuItem[] => {
    const items: MenuItem[] = [];
    const widget = widgetId
      ? widgetList.find((w) => w.id === widgetId)
      : undefined;
    const definition = widget
      ? (resolveWidgetDef(widget.app_slug, widget.widget_id)?.def ?? null)
      : null;
    if (widget && isConfigurable(definition)) {
      items.push({
        label: "Configure widget",
        icon: <Settings className="h-4 w-4 text-muted-foreground" />,
        onClick: () => setConfiguringId(widget.id),
      });
    }
    items.push({
      label: "Edit Dashboard",
      icon: <Pencil className="h-4 w-4 text-muted-foreground" />,
      onClick: handleEnterEdit,
    });
    return items;
  };

  return (
    <div
      className="relative h-full"
      // The resize handles are rendered by react-grid-layout whether or not
      // resizing is on, so the stylesheet needs to know when the dashboard is
      // being edited to show them. One attribute here beats a class on every
      // grid item.
      data-dashboard-editing={isEditing || undefined}
      ref={containerRef}
      onContextMenu={handleContextMenu}
    >
      {widgetList.length === 0 ? (
        <div
          className={cn(
            "flex h-full flex-col items-center justify-center gap-4",
            emptyStateHidden && "invisible",
            tourActive && !emptyStateHidden && "tour-screen-in",
          )}
        >
          <p className="text-lg text-muted-foreground">
            Your dashboard is empty
          </p>
          {!isEditing && (
            <button
              onClick={() => {
                setIsEditing(true);
                setCatalogOpen(true);
              }}
              data-tour="edit-dashboard"
              className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand/90"
            >
              Add Widgets
            </button>
          )}
        </div>
      ) : (
        <>
          <Responsive
            className="layout"
            width={width}
            layouts={{ lg: layout as unknown as RGLLayout }}
            breakpoints={{ lg: 1200, md: 996, sm: 768 }}
            cols={{ lg: 12, md: 8, sm: 4 }}
            rowHeight={100}
            dragConfig={{
              enabled: isEditing,
              handle: ".widget-drag-handle",
              cancel: ".widget-bar-action",
            }}
            resizeConfig={{ enabled: isEditing }}
            onBreakpointChange={handleBreakpointChange}
            onLayoutChange={handleLayoutChange}
            onDragStart={() => setIsDraggingWidget(true)}
            onDragStop={() => setIsDraggingWidget(false)}
          >
            {widgetList.map((widget) => {
              const resolved = resolveWidgetDef(
                widget.app_slug,
                widget.widget_id,
              );
              return (
                <div
                  key={widget.id}
                  data-tour-widget-instance={widget.app_slug}
                  onDoubleClick={() => {
                    if (!isEditing) handleEnterEdit();
                  }}
                  onContextMenu={(e) => handleWidgetContextMenu(e, widget.id)}
                >
                  <WidgetWrapper
                    widget={widget}
                    definition={resolved?.def ?? null}
                    appSlug={widget.app_slug}
                    onRemove={() => handleRemoveWidget(widget.id)}
                    configOpen={configuringId === widget.id}
                    onOpenConfig={() => setConfiguringId(widget.id)}
                    onCloseConfig={() => setConfiguringId(null)}
                  />
                </div>
              );
            })}
          </Responsive>
        </>
      )}

      {!isEditing && !isCollapsing && widgetList.length > 0 && (
        <button
          onClick={handleEnterEdit}
          aria-label="Edit dashboard"
          title="Edit dashboard"
          data-tour="dashboard-pencil"
          className={`group fixed bottom-6 right-6 z-40 flex h-9 items-center overflow-hidden rounded-full bg-primary px-2.5 text-white shadow-sm backdrop-blur transition-opacity duration-500 hover:bg-primary/90 ${
            pencilVisible ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
        >
          <Pencil className="h-4 w-4 shrink-0" />
          <span className="max-w-0 overflow-hidden whitespace-nowrap text-sm font-medium opacity-0 transition-all duration-300 group-hover:ml-2 group-hover:max-w-[140px] group-hover:opacity-100">
            Edit Dashboard
          </span>
        </button>
      )}

      {(isEditing || isCollapsing) && (
        <div
          ref={pillRef}
          className={`fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-card/95 px-2 py-2 shadow-lg backdrop-blur transition-opacity duration-200 ${
            isCollapsing || isExpanding ? "overflow-hidden" : ""
          } ${isDraggingWidget ? "opacity-20" : "opacity-100"}`}
        >
          <button
            onClick={() => setCatalogOpen(true)}
            disabled={isCollapsing || isExpanding}
            data-tour="add-widget"
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium hover:bg-accent ${
              isCollapsing || isExpanding
                ? "pointer-events-none opacity-0"
                : "transition-opacity duration-200"
            }`}
          >
            <Plus className="h-4 w-4" />
            Add Widget
          </button>
          <button
            onClick={handleDoneEditing}
            disabled={isCollapsing || isExpanding}
            data-tour="done-editing"
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-white hover:bg-primary/90 ${
              isCollapsing || isExpanding
                ? "pointer-events-none opacity-0"
                : "transition-opacity duration-200"
            }`}
          >
            Done Editing Dashboard
          </button>
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          label={contextMenu.widgetId ? "Widget" : "Dashboard"}
          items={contextMenuItems(contextMenu.widgetId)}
          onClose={closeContextMenu}
        />
      )}

      {catalogOpen && (
        <WidgetCatalog
          apps={availableApps}
          onClose={() => setCatalogOpen(false)}
          onWidgetAdded={handleWidgetAdded}
        />
      )}
    </div>
  );
}
