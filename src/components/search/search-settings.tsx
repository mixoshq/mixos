/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import LucideIcon from "@/components/lucide-icon";
import { IconButton } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import Notice from "@/components/ui/notice";
import { Toggle } from "@/components/ui/toggle";
import { useListReorder } from "@/lib/dnd/use-list-reorder";
import {
  mergeOrder,
  orderSources,
  type SearchPreferences,
  type SearchSourceView,
} from "@/lib/search/types";
import { cn } from "@/lib/utils";
import { useSearch } from "./search-context";

/**
 * The Search page in My Account: the two ways in (the menu-bar icon and the
 * shortcut), and which apps are searched, in what order.
 *
 * Every change is saved as it is made, through the search provider, so the
 * menu bar's icon comes and goes while the person is looking at the switch.
 * The order and the switches are read from the provider too; `sources` gives
 * only what each source is called.
 */
export default function SearchSettings({ sources }: { sources: SearchSourceView[] }) {
  const { prefs, updatePrefs, shortcutLabel, available } = useSearch();
  const [error, setError] = useState<string | null>(null);

  const byKey = useMemo(() => new Map(sources.map((s) => [s.key, s])), [sources]);
  const ordered = useMemo(
    () => orderSources(sources.map((s) => s.key), prefs.order).map((key) => byKey.get(key)!),
    [sources, byKey, prefs.order],
  );
  const disabled = useMemo(() => new Set(prefs.disabled), [prefs.disabled]);

  async function save(next: SearchPreferences) {
    setError(null);
    const failed = await updatePrefs(next);
    if (failed) setError(failed);
  }

  function reorder(next: SearchSourceView[]) {
    void save({ ...prefs, order: mergeOrder(next.map((s) => s.key), prefs.order) });
  }

  function move(index: number, by: -1 | 1) {
    const to = index + by;
    if (to < 0 || to >= ordered.length) return;
    const next = [...ordered];
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    reorder(next);
  }

  function setEnabled(key: string, on: boolean) {
    const rest = prefs.disabled.filter((k) => k !== key);
    void save({ ...prefs, disabled: on ? rest : [...rest, key] });
  }

  const { getItemProps, dragIndex, dragOverIndex } = useListReorder({ items: ordered, onReorder: reorder });

  const onlyApps = sources.every((s) => s.key.startsWith("@"));

  return (
    <div className="mt-4 space-y-6 md:max-w-2xl">
      {error && <Notice tone="danger">{error}</Notice>}

      <Card>
        <CardHeader
          title="Opening search"
          description="Search finds an app by its name, and what's inside the apps you've installed."
        />
        <CardBody className="space-y-5">
          <SettingRow
            label="Search icon in the menu bar"
            description="A magnifying glass at the top right, before What's new."
          >
            <Toggle
              checked={prefs.showIcon}
              onCheckedChange={(on) => void save({ ...prefs, showIcon: on })}
              label="Search icon in the menu bar"
              onText="Shown"
              offText="Hidden"
            />
          </SettingRow>
          <SettingRow
            label={`Keyboard shortcut (${shortcutLabel})`}
            description={`Press ${shortcutLabel} anywhere in MixOS to open search.`}
          >
            <Toggle
              checked={prefs.shortcutEnabled}
              onCheckedChange={(on) => void save({ ...prefs, shortcutEnabled: on })}
              label={`Keyboard shortcut ${shortcutLabel}`}
              onText="On"
              offText="Off"
            />
          </SettingRow>
          {!available && (
            <Notice tone="warning" title="Search is off">
              With the icon hidden and the shortcut off, there&apos;s no way to open search. Turn either one back on
              to use it again.
            </Notice>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Apps to search"
          description="Results are grouped by app, in this order. Drag an app, or use the arrows, to move it; switch one off to leave it out of search."
        />
        <CardBody>
          <ul className="space-y-2" aria-label="Apps to search, in order">
            {ordered.map((source, index) => {
              const on = !disabled.has(source.key);
              return (
                <li
                  key={source.key}
                  {...getItemProps(index)}
                  className={cn(
                    "flex items-center gap-3 rounded-md border border-border p-3 transition-colors",
                    dragIndex === index && "opacity-50",
                    dragOverIndex === index && dragIndex !== index && "border-primary",
                  )}
                >
                  <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground">
                    <LucideIcon name={source.icon} className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">{source.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{source.objects.join(", ")}</span>
                  </span>
                  <span className="flex shrink-0 items-center">
                    <IconButton
                      size="sm"
                      variant="ghost"
                      label={`Move ${source.name} up`}
                      icon={<ArrowUp className="h-4 w-4" />}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    />
                    <IconButton
                      size="sm"
                      variant="ghost"
                      label={`Move ${source.name} down`}
                      icon={<ArrowDown className="h-4 w-4" />}
                      disabled={index === ordered.length - 1}
                      onClick={() => move(index, 1)}
                    />
                  </span>
                  <Toggle
                    checked={on}
                    onCheckedChange={(next) => setEnabled(source.key, next)}
                    label={`Search ${source.name}`}
                    onText="On"
                    offText="Off"
                  />
                </li>
              );
            })}
          </ul>
          {onlyApps && (
            <p className="mt-3 text-sm text-muted-foreground">
              None of the apps you&apos;ve installed offer search yet. When one does, it appears here, at the end, and
              switched on.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}
