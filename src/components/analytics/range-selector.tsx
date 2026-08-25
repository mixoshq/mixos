"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

const RANGES = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
] as const;

/**
 * Date-range control for the Analytics page. Pushes `?range=` into the URL so
 * the page stays a server component and the view is shareable/bookmarkable.
 */
export default function RangeSelector({ current }: { current: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function select(value: number) {
    const params = new URLSearchParams(searchParams);
    params.set("range", String(value));
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
      {RANGES.map((r) => {
        const active = r.value === current;
        return (
          <button
            key={r.value}
            onClick={() => select(r.value)}
            className={
              active
                ? "rounded-md bg-mixnavy px-3 py-1.5 text-sm font-medium text-white"
                : "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            }
          >
            Last {r.label}
          </button>
        );
      })}
    </div>
  );
}
