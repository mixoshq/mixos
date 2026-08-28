/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

export interface SourceOption {
  /** "" for the overview, or "app:<slug>" / "connector:<name>". */
  value: string;
  label: string;
}

/**
 * Picker for the Analytics page: Overview, or a specific app/connector that
 * declares telemetry. Pushes `?source=` into the URL (preserving `range`) so
 * the page stays a server component and the view is shareable.
 */
export default function SourceSelector({
  current,
  apps,
  connectors,
}: {
  current: string;
  apps: SourceOption[];
  connectors: SourceOption[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function select(value: string) {
    const params = new URLSearchParams(searchParams);
    if (value) params.set("source", value);
    else params.delete("source");
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <select
      value={current}
      onChange={(e) => select(e.target.value)}
      className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-foreground"
      aria-label="Analytics source"
    >
      <option value="">Overview</option>
      {apps.length > 0 && (
        <optgroup label="Apps">
          {apps.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      )}
      {connectors.length > 0 && (
        <optgroup label="Connectors">
          {connectors.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
