# Right-click a dashboard widget: Configure widget, Edit Dashboard

**Status:** built
**Scope:** platform — `src/components/dashboard/`, `src/components/ui/menu.tsx`

## Context

Right-clicking empty dashboard space opens a one-item menu, **Edit Dashboard**.
Right-clicking a widget does nothing of ours: the grid deliberately lets the
browser's own menu through, so changing a widget's settings means entering edit
mode and finding the gear on its edit bar.

The request: right-clicking a widget offers **Configure widget**, when the
widget declares config fields, and **Edit Dashboard**.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Where the browser's menu still wins | On a link, a form field, editable text, or text the user has selected inside the widget. Also when the widget's own code already handled the right-click (`preventDefault`) | Those are the cases where "Open in new tab", "Copy" and "Paste" are what the user is reaching for. The rest of a widget has nothing for the native menu to act on. |
| In edit mode | Unchanged: no custom menu | The edit bar already shows Configure and Remove, and "Edit Dashboard" means nothing while editing. |
| A widget with no config, or an unknown widget | The menu shows only **Edit Dashboard** | Configure is left out rather than disabled, following the platform rule for controls a user can't use. |
| One menu or two | One `ContextMenu` primitive, used for both empty space and widgets | One place handles dismissal, keyboard support and keeping the menu on screen. |

## Structure

- **`src/components/ui/menu.tsx`** gets a `ContextMenu({ x, y, items, onClose })`
  export beside `Menu`. It reuses `MenuItem` and the item styling. It closes on
  an outside mousedown, Escape, Tab, scroll, resize, or when an item runs. It
  focuses itself on open, not its first item, so a right-click doesn't show a
  focus ring on an item the pointer isn't on. ArrowDown and ArrowUp move onto
  and between items, as do Home and End. It gives focus back to the element
  that had it, and moves itself so it stays inside the viewport.
- **`src/components/dashboard/grid.tsx`**:
  - The context-menu state gains an optional `widgetId`.
  - Each grid item gets an `onContextMenu` that opens the menu for that widget,
    unless `prefersNativeMenu()` says the browser's own menu should win.
  - The grid owns `configuringId`, the widget whose config modal is open. That
    lets both the menu and the edit-bar gear open the same modal.
  - The inline menu markup is replaced by `ContextMenu`.
- **`src/components/dashboard/widget-wrapper.tsx`**: the config modal's open
  state moves to the grid. The wrapper takes `configOpen`, `onOpenConfig` and
  `onCloseConfig` props. The modal itself is unchanged.

The header has its own copy of this menu for right-clicking the Dashboard nav
item. It is left alone here and could move to `ContextMenu` later.

## Verification

1. `npm run typecheck`, and `npx eslint` on the changed files.
2. In a browser at `/`, with one configurable widget and one without config:
   - Right-click the configurable widget: the menu shows Configure widget and
     Edit Dashboard. Configure widget opens the modal, and saving it keeps the
     new config.
   - Right-click the widget without config: the menu shows only Edit Dashboard,
     and choosing it enters edit mode.
   - Right-click empty space: the menu shows Edit Dashboard, as before.
   - Right-click a link inside a widget: the browser's own menu appears.
   - In edit mode, right-click a widget: the browser's own menu appears, and
     the gear still opens the config modal.
   - Escape and an outside click both close the menu. Near the right and bottom
     edges, the menu stays on screen.
