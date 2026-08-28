/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WidgetConfigField } from "./types";

/**
 * Reusable widget-config field builders. Use these in app manifests
 * (`app.ts`) to keep common patterns consistent across widgets and — more
 * importantly — to get a fully-typed `config` object in the widget.
 *
 * Each builder is generic over its key (so `titleField({ key: "header" })`
 * gives you `config.header`) and returns a narrow return type that
 * encodes the value shape. Collect them into an `as const` array and feed
 * `InferConfig<typeof fields>` to derive the widget's config type:
 *
 *   const fields = [
 *     titleField({ default: "Favorites" }),
 *     selectionField({ key: "linkIds", label: "Links to show" }),
 *     displayModeField({ modes: ["list", "icon"], default: "list" }),
 *     groupByField({ label: "Group by category" }),
 *   ] as const;
 *
 *   type FavoritesConfig = InferConfig<typeof fields>;
 *   //   ^? { title: string; linkIds: string[];
 *   //       displayMode: "list" | "icon"; groupByCategory: boolean }
 *
 * The widget then declares `WidgetProps<FavoritesConfig>` and its
 * `config` object is fully typed — no `as string` casts, and renaming a
 * manifest key breaks the widget at compile time.
 */

export function titleField<const K extends string = "title">(opts?: {
  key?: K;
  label?: string;
  default?: string;
  required?: boolean;
}) {
  return {
    key: (opts?.key ?? "title") as K,
    label: opts?.label ?? "Title",
    type: "text" as const,
    required: opts?.required ?? true,
    default: opts?.default ?? "",
  };
}

export type DisplayMode = "list" | "grid" | "icon";

const DISPLAY_MODE_LABELS: Record<DisplayMode, string> = {
  list: "List",
  grid: "Grid",
  icon: "Icon grid",
};

export function displayModeField<
  const K extends string = "displayMode",
  const M extends DisplayMode = DisplayMode,
>(opts: {
  key?: K;
  label?: string;
  modes: readonly M[];
  default?: M;
}) {
  return {
    key: (opts.key ?? "displayMode") as K,
    label: opts.label ?? "Display",
    type: "select" as const,
    default: opts.default ?? opts.modes[0],
    options: opts.modes.map((m) => ({
      label: DISPLAY_MODE_LABELS[m],
      value: m,
    })),
  };
}

/**
 * Boolean "group by X" field. Commonly paired with a `resolveConfig` that
 * hides the field when the grouping dimension has no values (e.g. no
 * categories exist yet) by returning `{ visible: false }`.
 */
export function groupByField<const K extends string = "groupByCategory">(opts?: {
  key?: K;
  label?: string;
  default?: boolean;
}) {
  return {
    key: (opts?.key ?? "groupByCategory") as K,
    label: opts?.label ?? "Group by category",
    type: "boolean" as const,
    default: opts?.default ?? false,
  };
}

/**
 * Multiselect field populated at open time by `resolveConfig`. Value type
 * is `string[]` — the runtime options are discovered dynamically, so we
 * can't narrow further at compile time.
 */
export function selectionField<const K extends string>(opts: {
  key: K;
  label: string;
  ordered?: boolean;
  default?: string[];
}) {
  return {
    key: opts.key,
    label: opts.label,
    type: "multiselect" as const,
    ordered: opts.ordered ?? true,
    default: opts.default ?? [],
  };
}

// -------- Type inference helpers --------

/**
 * Derives the runtime value type of a single config field from its `type`
 * (and, for `select`/`multiselect` with a static `options` array, its
 * option values). Fields whose options are supplied dynamically by
 * `resolveConfig` degrade to `string` / `string[]`.
 */
export type FieldValue<F> = F extends { type: "text" }
  ? string
  : F extends { type: "number" }
    ? number
    : F extends { type: "boolean" }
      ? boolean
      : F extends {
            type: "multiselect";
            options: ReadonlyArray<{ value: infer V extends string }>;
          }
        ? V[]
        : F extends { type: "multiselect" }
          ? string[]
          : F extends {
                type: "select";
                options: ReadonlyArray<{ value: infer V extends string }>;
              }
            ? V
            : F extends { type: "select" }
              ? string
              : unknown;

/**
 * Maps a readonly tuple of config fields into a typed config object
 * keyed by each field's `key`. Use on a preset-field tuple declared with
 * `as const` — the widget consumes the resulting type via `WidgetProps`.
 */
export type InferConfig<
  T extends ReadonlyArray<{ key: string; type: string }>,
> = {
  [F in T[number] as F["key"]]: FieldValue<F>;
};

// Re-export for consumers that want to declare manifests against a single
// erased type (e.g. when building custom field shapes).
export type { WidgetConfigField };
