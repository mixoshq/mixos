/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState, useEffect, useId, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, GripVertical, Plus } from "lucide-react";
import type { WidgetDefinition, WidgetConfigField } from "@/lib/apps/types";
import type { ResolvedConfig } from "@/lib/hooks/types";
import { widgetLoaders } from "@/generated/app-registry";
import { missingRequiredFields } from "@/lib/apps/widget-config-required";
import { useListReorder } from "@/lib/dnd/use-list-reorder";
import { CARD_SURFACE } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface WidgetConfigModalProps {
  appSlug: string;
  widget: WidgetDefinition;
  initialConfig?: Record<string, unknown>;
  submitLabel?: string;
  onClose: () => void;
  onSave: (config: Record<string, unknown>) => void;
}

export default function WidgetConfigModal({
  appSlug,
  widget,
  initialConfig = {},
  submitLabel = "Add Widget",
  onClose,
  onSave,
}: WidgetConfigModalProps) {
  const [config, setConfig] = useState<Record<string, unknown>>(initialConfig);
  const [resolvedConfig, setResolvedConfig] = useState<ResolvedConfig>({});
  const [loading, setLoading] = useState(true);
  const idBase = useId();
  const errorId = (key: string) => `${idBase}-${key}-error`;

  useEffect(() => {
    async function resolve() {
      try {
        const key = `${appSlug}/${widget.component}`;
        const loader = widgetLoaders[key];
        if (!loader) {
          setLoading(false);
          return;
        }
        const mod = await loader();
        if (mod.resolveConfig) {
          const resolved = await mod.resolveConfig({ appSlug });
          setResolvedConfig(resolved);
        }
      } catch {
        // No resolveConfig or import failed
      }
      setLoading(false);
    }
    resolve();
  }, [appSlug, widget.component]);

  // Derived, not written by an effect. The old version setState'd inside an
  // effect that also depended on `config`, which is the cascading-render shape
  // React's rule flags — and it re-ran on every keystroke to re-merge defaults
  // that had not changed.
  const effectiveConfig = useMemo(() => {
    const defaults: Record<string, unknown> = {};
    for (const field of widget.config ?? []) {
      if (field.default !== undefined) defaults[field.key] = field.default;
      const resolvedDefault = resolvedConfig[field.key]?.default;
      if (resolvedDefault !== undefined) defaults[field.key] = resolvedDefault;
    }
    // A value the user actually set always wins over a default.
    return { ...defaults, ...config };
  }, [widget.config, resolvedConfig, config]);

  // `required` is enforced here, on save: an empty required field keeps the
  // modal open and says which one. Shown only after a save attempt, so a form
  // that opens empty does not open covered in errors; derived from the current
  // values, so each message clears as its field is filled.
  const [triedToSave, setTriedToSave] = useState(false);
  const missing = useMemo(
    () =>
      new Set(
        missingRequiredFields(widget.config ?? [], effectiveConfig, resolvedConfig),
      ),
    [widget.config, effectiveConfig, resolvedConfig],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (missing.size > 0) {
      setTriedToSave(true);
      return;
    }
    onSave(effectiveConfig);
  };

  const renderField = (field: WidgetConfigField) => {
    const resolved = resolvedConfig[field.key];
    const options = resolved?.options ?? field.options ?? [];
    const invalid = triedToSave && missing.has(field.key);
    // On the inputs that can carry them; the grouped controls rely on the
    // message rendered under them.
    const a11y = {
      "aria-required": field.required || undefined,
      "aria-invalid": invalid || undefined,
      "aria-describedby": invalid ? errorId(field.key) : undefined,
    };

    switch (field.type) {
      case "multiselect": {
        const selected = Array.isArray(effectiveConfig[field.key])
          ? (effectiveConfig[field.key] as string[])
          : [];
        if (field.ordered) {
          return (
            <OrderedMultiselect
              fieldKey={field.key}
              options={options}
              selected={selected}
              onChange={(next) =>
                setConfig((prev) => ({ ...prev, [field.key]: next }))
              }
            />
          );
        }
        const toggle = (value: string) => {
          setConfig((prev) => {
            const curr = Array.isArray(prev[field.key])
              ? (prev[field.key] as string[])
              : [];
            const next = curr.includes(value)
              ? curr.filter((v) => v !== value)
              : [...curr, value];
            return { ...prev, [field.key]: next };
          });
        };
        return (
          <div className="max-h-48 overflow-auto rounded-md border border-input bg-background p-2">
            {options.length === 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                No options available.
              </p>
            ) : (
              options.map((opt) => (
                <label
                  key={opt.value}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(opt.value)}
                    onChange={() => toggle(opt.value)}
                    className="rounded"
                  />
                  <span className="truncate">{opt.label}</span>
                </label>
              ))
            )}
          </div>
        );
      }
      case "select":
        return (
          <select
            {...a11y}
            value={(effectiveConfig[field.key] as string) ?? ""}
            onChange={(e) =>
              setConfig((prev) => ({ ...prev, [field.key]: e.target.value }))
            }
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="">Select...</option>
            {options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        );
      case "boolean":
        return (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={!!effectiveConfig[field.key]}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  [field.key]: e.target.checked,
                }))
              }
              className="rounded"
            />
            <span className="text-sm">{field.label}</span>
          </label>
        );
      case "number":
        return (
          <input
            {...a11y}
            type="number"
            value={(effectiveConfig[field.key] as number) ?? ""}
            onChange={(e) =>
              setConfig((prev) => ({
                ...prev,
                [field.key]: Number(e.target.value),
              }))
            }
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        );
      default:
        return (
          <input
            {...a11y}
            type="text"
            value={(effectiveConfig[field.key] as string) ?? ""}
            onChange={(e) =>
              setConfig((prev) => ({ ...prev, [field.key]: e.target.value }))
            }
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
          />
        );
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className={cn(
          "mix-modal",
          CARD_SURFACE,
          "mx-4 w-full max-w-md shadow-xl",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold">Configure {widget.name}</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center p-8">
            <p className="text-sm text-muted-foreground">
              Loading configuration...
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6">
            <div className="space-y-4">
              {widget.config
                ?.filter(
                  (field) => resolvedConfig[field.key]?.visible !== false,
                )
                .map((field) => (
                  <div key={field.key}>
                    {field.type !== "boolean" && (
                      <label className="mb-1 block text-sm font-medium">
                        {field.label}
                        {field.required && (
                          <span className="ml-1 text-destructive">*</span>
                        )}
                      </label>
                    )}
                    {renderField(field)}
                    {triedToSave && missing.has(field.key) && (
                      <p
                        id={errorId(field.key)}
                        className="mt-1 text-xs text-destructive"
                      >
                        {field.label} is required.
                      </p>
                    )}
                  </div>
                ))}
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand/90"
              >
                {submitLabel}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

function OrderedMultiselect({
  fieldKey,
  options,
  selected,
  onChange,
}: {
  fieldKey: string;
  options: { label: string; value: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const { getItemProps, dragIndex, dragOverIndex } = useListReorder({
    items: selected,
    onReorder: onChange,
  });

  const labelFor = (value: string) =>
    options.find((o) => o.value === value)?.label ?? value;
  const selectedSet = new Set(selected);
  const available = options.filter((o) => !selectedSet.has(o.value));

  function add(value: string) {
    onChange([...selected, value]);
  }

  function remove(value: string) {
    onChange(selected.filter((v) => v !== value));
  }

  if (options.length === 0) {
    return (
      <div className="rounded-md border border-input bg-background p-2">
        <p className="px-2 py-1 text-xs text-muted-foreground">
          No options available.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="max-h-40 overflow-auto rounded-md border border-input bg-background p-1">
        {selected.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            Nothing selected. Pick from the list below.
          </p>
        ) : (
          <ul>
            {selected.map((value, i) => (
              <li
                key={`${fieldKey}-${value}`}
                {...getItemProps(i)}
                className={`flex items-center gap-2 rounded px-1.5 py-1 text-sm ${
                  dragOverIndex === i && dragIndex !== null && dragIndex !== i
                    ? "bg-accent"
                    : "hover:bg-muted"
                } ${dragIndex === i ? "opacity-50" : ""}`}
              >
                <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-muted-foreground" />
                <span className="flex-1 truncate">{labelFor(value)}</span>
                <button
                  type="button"
                  onClick={() => remove(value)}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                  aria-label={`Remove ${labelFor(value)}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {available.length > 0 && (
        <div className="max-h-32 overflow-auto rounded-md border border-input bg-background p-1">
          <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Available
          </p>
          <ul>
            {available.map((opt) => (
              <li key={`${fieldKey}-avail-${opt.value}`}>
                <button
                  type="button"
                  onClick={() => add(opt.value)}
                  className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-muted"
                >
                  <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{opt.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
