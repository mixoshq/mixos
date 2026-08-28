"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { WidgetProps } from "@/lib/hooks/types";
import { createAppClient } from "@/lib/apps/sdk";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Example widget that calls this app's own API route via the SDK.
 *
 * Widgets and pages cannot import connectors or the DB directly — they
 * must go through an API route, which receives an initialized AppContext
 * from the platform gateway.
 */
export default function HelloMixOSWidget({ appSlug }: WidgetProps) {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const client = createAppClient(appSlug);
    client
      .get<{ message: string }>("/hello")
      .then((res) => setMessage(res.message))
      .catch(() => setMessage("Hello MONTALBANO"));
  }, [appSlug]);

  if (!message) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="mt-2 h-8 w-24 rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <p className="text-2xl font-bold">{message}</p>
      <p className="mt-1 text-sm text-muted-foreground">Welcome!</p>
      <Link
        href={`/apps/${appSlug}`}
        className="mt-3 rounded-full bg-mixcharcoal px-4 py-1.5 text-sm font-medium text-white hover:bg-mixcharcoal/80 transition-colors"
      >
        Launch
      </Link>
    </div>
  );
}
