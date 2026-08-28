/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use client";

import { useState } from "react";
import type { OpenTrendPoint } from "@/lib/analytics/queries";

/**
 * Single-series daily trend of discrete counts (app opens, or telemetry
 * events/calls). Bars over time with a hover tooltip. Single series → no
 * legend; the section title names it. `noun` (singular) labels the count in
 * the tooltip and footer — defaults to "open".
 */
export default function OpenTrendChart({
  data,
  noun = "open",
}: {
  data: OpenTrendPoint[];
  noun?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const max = Math.max(1, ...data.map((d) => d.opens));
  const total = data.reduce((sum, d) => sum + d.opens, 0);

  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No data for this range yet.</p>
    );
  }

  // Show a compact set of x labels (first, middle, last) to avoid crowding.
  const labelIdx = new Set([0, Math.floor(data.length / 2), data.length - 1]);

  return (
    <div>
      <div
        className="flex h-40 items-end gap-px"
        onMouseLeave={() => setHover(null)}
      >
        {data.map((d, i) => {
          const heightPct = (d.opens / max) * 100;
          const active = hover === i;
          return (
            <div
              key={d.day}
              className="relative flex min-w-0 flex-1 items-end"
              style={{ height: "100%" }}
              onMouseEnter={() => setHover(i)}
            >
              <div
                className={
                  active
                    ? "w-full rounded-t-[4px] bg-brand"
                    : "w-full rounded-t-[4px] bg-brand/60"
                }
                style={{ height: `${Math.max(heightPct, d.opens > 0 ? 2 : 0)}%` }}
                title={`${d.day}: ${d.opens} ${noun}${d.opens === 1 ? "" : "s"}`}
              />
              {active && (
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-card px-2 py-1 text-xs shadow-lg">
                  <span className="font-medium text-foreground">{d.opens}</span>
                  <span className="text-muted-foreground"> · {d.day}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
        {data.map((d, i) => (
          <span key={d.day} className={labelIdx.has(i) ? "" : "invisible"}>
            {d.day.slice(5)}
          </span>
        ))}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {total.toLocaleString()} total {noun}{total === 1 ? "" : "s"} in this range
      </p>
    </div>
  );
}
