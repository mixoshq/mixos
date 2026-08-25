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
import { Plus, Pencil } from "lucide-react";
import type { LayoutItem, DashboardWidget } from "@/lib/dashboard/actions";
import { saveLayout, removeWidget } from "@/lib/dashboard/actions";
import type { AppManifest, WidgetDefinition } from "@/lib/apps/types";
import WidgetWrapper from "./widget-wrapper";
import WidgetCatalog from "./widget-catalog";
import { useDashboardEdit } from "./edit-mode-context";

import "react-grid-layout/css/styles.css";

type Breakpoint = "lg" | "md" | "sm";

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
  const currentBreakpointRef = useRef<Breakpoint>("lg");
  const [pencilVisible, setPencilVisible] = useState(true);
  const [isDraggingWidget, setIsDraggingWidget] = useState(false);
  const [isCollapsing, setIsCollapsing] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const handleBreakpointChange = useCallback((newBreakpoint: Breakpoint) => {
    currentBreakpointRef.current = newBreakpoint;
  }, []);

  // Fade the pencil out after 20s of no cursor motion on the dashboard; any
  // mouse movement re-shows it and resets the timer.
  useEffect(() => {
    if (isEditing || widgetList.length === 0) {
      setPencilVisible(true);
      return;
    }
    const el = containerRef.current;
    if (!el) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      setPencilVisible(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setPencilVisible(false), 20_000);
    };

    arm();
    el.addEventListener("mousemove", arm);
    return () => {
      el.removeEventListener("mousemove", arm);
      if (timer) clearTimeout(timer);
    };
  }, [isEditing, widgetList.length, containerRef]);

  // Dismiss the right-click context menu on outside click, Escape, or scroll.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    // Ignore mousedowns inside the menu itself — closing on a menu-item's own
    // mousedown would unmount the button before its click fires, so the item
    // would never activate.
    const onDown = (e: MouseEvent) => {
      if (contextMenuRef.current?.contains(e.target as Node)) return;
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
  }, [contextMenu]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (isEditing) return;
      // Only hijack the native menu on empty dashboard space — right-clicking
      // inside a widget's content should still yield the browser's own menu.
      if ((e.target as HTMLElement).closest(".react-grid-item")) return;
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY });
    },
    [isEditing],
  );

  const handleLayoutChange = useCallback(
    (newLayout: RGLLayout) => {
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
    },
    []
  );

  const handleRemoveWidget = useCallback(
    async (instanceId: string) => {
      await removeWidget(instanceId);
      setWidgetList((prev) => prev.filter((w) => w.id !== instanceId));
      setLayout((prev) => prev.filter((item) => item.i !== instanceId));
    },
    []
  );

  // Click the pencil → mount the pill but immediately animate it FROM the
  // pencil's slot TO its natural centered position. Mirror of the collapse so
  // the user sees the same shape transformation in reverse.
  const handleEnterEdit = useCallback(() => {
    if (isExpanding || isCollapsing) return;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduced) {
      setIsEditing(true);
      return;
    }

    setIsExpanding(true);
    setIsEditing(true);
  }, [isExpanding, isCollapsing, setIsEditing]);

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
    []
  );

  const resolveWidgetDef = (
    appSlug: string,
    widgetId: string
  ): { app: AppManifest; def: WidgetDefinition } | null => {
    const app = availableApps.find((a) => a.slug === appSlug);
    if (!app) return null;
    const def = app.widgets.find((w) => w.id === widgetId);
    if (!def) return null;
    return { app, def };
  };

  return (
    <div
      className="relative h-full"
      ref={containerRef}
      onContextMenu={handleContextMenu}
    >
      {widgetList.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-4">
          <p className="text-lg text-muted-foreground">
            Your dashboard is empty
          </p>
          {!isEditing && (
            <button
              onClick={() => setIsEditing(true)}
              data-tour="edit-dashboard-btn"
              className="flex items-center gap-2 rounded-lg bg-mixcharcoal px-4 py-2 text-sm font-medium text-white hover:bg-mixcharcoal/90"
            >
              Edit Dashboard
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
                widget.widget_id
              );
              return (
                <div
                  key={widget.id}
                  onDoubleClick={() => {
                    if (!isEditing) handleEnterEdit();
                  }}
                >
                  <WidgetWrapper
                    widget={widget}
                    definition={resolved?.def ?? null}
                    appSlug={widget.app_slug}
                    onRemove={() => handleRemoveWidget(widget.id)}
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
          className={`group fixed bottom-6 right-6 z-40 flex h-9 items-center overflow-hidden rounded-full bg-mixgrey px-2.5 text-white shadow-sm backdrop-blur transition-opacity duration-500 hover:bg-mixgrey/90 ${
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
            data-tour="add-widget-btn"
            disabled={isCollapsing || isExpanding}
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
            data-tour="done-editing-btn"
            disabled={isCollapsing || isExpanding}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-full bg-mixgrey px-3 py-1.5 text-sm font-medium text-white hover:bg-mixgrey/90 ${
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
        <div
          ref={contextMenuRef}
          role="menu"
          className="fixed z-50 min-w-[160px] rounded-lg border border-border bg-card py-1 shadow-lg"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            role="menuitem"
            onClick={() => {
              setContextMenu(null);
              handleEnterEdit();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
          >
            <Pencil className="h-4 w-4" />
            Edit Dashboard
          </button>
        </div>
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
